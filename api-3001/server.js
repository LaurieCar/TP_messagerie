const express = require("express");
const axios = require("axios");

const PORT = 3001;
const MY_URL = nettoyer(process.env.MY_URL || "http://" + process.env.MY_IP + ":" + PORT);

const TIMEOUT = 15000;
const DELAI_PING = 5000;
const DELAI_POIGNEE_DE_MAIN = 15000;
const MAX_ESSAIS = 5;

const app = express();

const enCours = new Set();
const actives = [];
const inactives = {};
const minuteurs = {};
const pingsSansPong = {};
const MESSAGES = [];
const vus = new Set();
let dernierHorodatage = 0;

function nettoyer(adresse) {
  return adresse && adresse.replace(/\/+$/, "");
}

function attendre(duree) {
  return new Promise((resolve) => setTimeout(resolve, duree));
}

function delaiBackoff(echecs) {
  return 1000 * Math.pow(2, echecs - 1);
}

function poster(url, corps) {
  return axios.post(url, corps, { headers: { Origin: MY_URL }, timeout: TIMEOUT });
}

async function posterAvecRetry(url, corps) {
  for (let essai = 1; ; essai++) {
    try {
      return await poster(url, corps);
    } catch (error) {
      const refusDefinitif = error.response && error.response.status < 500;
      if (refusDefinitif || essai >= MAX_ESSAIS) throw error;

      console.log("Échec vers " + url + " (" + essai + "/" + MAX_ESSAIS + "), nouvel essai dans " + delaiBackoff(essai) / 1000 + " s");
      await attendre(delaiBackoff(essai));
    }
  }
}

function arreterSurveillance(adresse) {
  const position = actives.indexOf(adresse);
  if (position !== -1) actives.splice(position, 1);
  clearTimeout(minuteurs[adresse]);
  delete minuteurs[adresse];
  delete pingsSansPong[adresse];
}

function activer(adresse) {
  enCours.delete(adresse);
  delete inactives[adresse];
  if (!actives.includes(adresse)) {
    actives.push(adresse);
    pingsSansPong[adresse] = 0;
    surveiller(adresse, 0);
  }
}

function desactiver(adresse, raison) {
  enCours.delete(adresse);
  arreterSurveillance(adresse);
  inactives[adresse] = raison;
}

function surveiller(adresse, echecs) {
  const delai = echecs === 0 ? DELAI_PING : delaiBackoff(echecs);

  minuteurs[adresse] = setTimeout(async () => {
    try {
      await axios.get(adresse + "/health", { headers: { Origin: MY_URL }, timeout: TIMEOUT });
      if (!actives.includes(adresse)) return;

      pingsSansPong[adresse] = pingsSansPong[adresse] + 1;
      if (pingsSansPong[adresse] >= MAX_ESSAIS) {
        console.log(adresse + " ne renvoie plus de /pong (" + pingsSansPong[adresse] + " pings) : PERDU");
        desactiver(adresse, "PERDU");
      } else {
        surveiller(adresse, 0);
      }
    } catch (error) {
      if (!actives.includes(adresse)) return;

      const total = echecs + 1;
      if (total >= MAX_ESSAIS) {
        console.log(adresse + " ne répond plus (" + total + " échecs) : PERDU");
        desactiver(adresse, "PERDU");
      } else {
        console.log("Ping raté vers " + adresse + " (" + total + "/" + MAX_ESSAIS + "), nouvel essai dans " + delaiBackoff(total) / 1000 + " s");
        surveiller(adresse, total);
      }
    }
  }, delai);
}

async function poigneeDeMain(to) {
  const limite = Date.now() + DELAI_POIGNEE_DE_MAIN;

  enCours.add(to);
  try {
    console.log("SYN envoyé à " + to);
    await poster(to + "/syn");
  } catch (error) {
    enCours.delete(to);
    console.log("Pas de réponse au SYN de " + to + " : " + error.message);
    return false;
  }

  while (Date.now() < limite) {
    if (actives.includes(to)) return true;
    await attendre(200);
  }

  enCours.delete(to);
  console.log("Poignée de main non terminée avec " + to);
  return false;
}

function horodater() {
  dernierHorodatage = Math.max(Date.now(), dernierHorodatage + 1);
  return new Date(dernierHorodatage).toISOString();
}

function cleMessage(metadata) {
  return metadata.source + "|" + metadata.timestamp;
}

function creerMessage(cible, action, content) {
  const message = {
    action: action,
    metadata: { source: MY_URL, target: cible, timestamp: horodater() },
    payload: content,
  };
  vus.add(cleMessage(message.metadata));
  return message;
}

function messageValide(body) {
  const metadata = body.metadata;
  return (
    typeof body.action === "string" &&
    Boolean(metadata) &&
    typeof metadata.source === "string" &&
    typeof metadata.target === "string" &&
    typeof metadata.timestamp === "string"
  );
}

app.get("/connexions", (req, res) => {
  res.json({ enCours: Array.from(enCours), actives: actives, inactives: inactives });
});

app.post("/connect", express.json(), async (req, res) => {
  const to = nettoyer(req.body.to);
  if (!to) return res.sendStatus(400);

  const connecte = await poigneeDeMain(to);
  if (connecte) return res.send("Connexion établie avec " + to);
  res.status(502).send("Poignée de main impossible avec " + to);
});

app.post("/disconnect", express.json(), async (req, res) => {
  const to = nettoyer(req.body.to);
  if (!to) return res.sendStatus(400);

  console.log("On oublie " + to + " (envoi de /forget)");
  desactiver(to, "OUBLIE");
  try {
    await poster(to + "/forget");
  } catch (error) {
    console.log("Erreur en envoyant /forget à " + to + " : " + error.message);
  }

  res.send("Connexion avec " + to + " terminée");
});

app.post("/syn", async (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);

  console.log("SYN reçu de " + from);
  arreterSurveillance(from);
  enCours.add(from);
  res.sendStatus(202);

  try {
    console.log("SYN-ACK envoyé à " + from);
    await posterAvecRetry(from + "/syn-ack");
  } catch (error) {
    enCours.delete(from);
    console.log("Poignée de main oubliée avec " + from + " : " + error.message);
  }
});

app.post("/syn-ack", async (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!enCours.has(from) && !actives.includes(from)) return res.sendStatus(403);

  console.log("SYN-ACK reçu de " + from);
  res.sendStatus(202);

  try {
    console.log("ACK envoyé à " + from);
    await posterAvecRetry(from + "/ack");
    activer(from);
    console.log("Connexion établie avec " + from);
  } catch (error) {
    enCours.delete(from);
    console.log("Poignée de main oubliée avec " + from + " : " + error.message);
  }
});

app.post("/ack", (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!enCours.has(from) && !actives.includes(from)) return res.sendStatus(403);

  console.log("ACK reçu de " + from + " : connexion établie");
  activer(from);
  res.sendStatus(204);
});

app.get("/health", (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(204);

  res.sendStatus(202);

  if (actives.includes(from)) {
    poster(from + "/pong").catch((error) => {
      console.log("Erreur en envoyant /pong à " + from + " : " + error.message);
    });
  }
});

app.post("/pong", (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!actives.includes(from)) return res.sendStatus(403);

  pingsSansPong[from] = 0;
  res.sendStatus(204);
});

app.post("/forget", (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!actives.includes(from)) return res.sendStatus(403);

  console.log(from + " nous a oubliés : OUBLIE");
  desactiver(from, "OUBLIE");
  res.sendStatus(204);
});

app.post("/ingress", express.json(), (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!actives.includes(from)) return res.sendStatus(403);
  if (!messageValide(req.body) || nettoyer(req.body.metadata.target) !== MY_URL) return res.sendStatus(400);

  const { action, metadata, payload } = req.body;
  const cle = cleMessage(metadata);
  if (vus.has(cle)) return res.sendStatus(208);
  vus.add(cle);

  MESSAGES.push({ from: from, date: Date.now(), action: action, metadata: metadata, payload: payload });
  console.log("Message reçu de " + metadata.source + " : " + JSON.stringify(payload));
  res.sendStatus(201);
});

app.get("/messages", (req, res) => {
  res.json(MESSAGES);
});

app.post("/send", express.json(), async (req, res) => {
  const to = nettoyer(req.body.to);
  if (!to) return res.sendStatus(400);
  if (!actives.includes(to)) return res.status(403).send("Pas de connexion établie avec " + to + " : faire /connect d'abord");

  try {
    const message = creerMessage(to, req.body.action || "MESSAGES", req.body.content);
    const response = await posterAvecRetry(to + "/ingress", message);
    console.log("Message envoyé à " + to + " (" + response.status + ") : " + JSON.stringify(req.body.content));
    res.send("Message envoyé à " + to);
  } catch (error) {
    console.log("Erreur en envoyant le message à " + to + " : " + error.message);
    res.status(502).send("Message refusé ou non délivré : " + error.message);
  }
});

app.listen(PORT, () => {
  console.log("API démarrée sur " + MY_URL);
});
