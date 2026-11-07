const express = require("express");
const axios = require("axios");

const PORT = 3000;
const MY_ID = process.env.MY_ID || "";
const MY_URL = nettoyer(process.env.MY_URL || "http://" + process.env.MY_IP + ":" + PORT);
const AUTORITE_URL = nettoyer(process.env.AUTORITE_URL);

const TIMEOUT = 15000;
const DELAI_PING = 5000;
const DELAI_POIGNEE_DE_MAIN = 15000;
const DELAI_ANNONCE = 30000;
const DUREE_FILE = 120000;
const MAX_ESSAIS = 5;

const app = express();

const enCours = new Set();
const actives = [];
const inactives = {};
const minuteurs = {};
const pingsSansPong = {};
const annuaire = {};
const MESSAGES = [];
const vus = new Set();
let fileAttente = [];
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

function ajouterPair(id, url) {
  if (id && url && id !== MY_ID) annuaire[id] = { id: id, url: nettoyer(url), publicKey: "" };
}

function listeAnnuaire() {
  const connus = Object.values(annuaire).map((pair) => ({ id: pair.id, url: pair.url }));
  return MY_ID ? [{ id: MY_ID, url: MY_URL }, ...connus] : connus;
}

async function annoncer() {
  if (!AUTORITE_URL || !MY_ID) return;

  try {
    const response = await axios.post(AUTORITE_URL + "/register", { id: MY_ID, url: MY_URL }, { timeout: TIMEOUT });
    if (Array.isArray(response.data)) response.data.forEach((pair) => ajouterPair(pair.id, pair.url));
  } catch (error) {
    console.log("Autorité injoignable : " + error.message);
  }
}

async function desinscrire() {
  if (!AUTORITE_URL || !MY_ID) return;

  try {
    await axios.delete(AUTORITE_URL + "/unregister/" + encodeURIComponent(MY_ID), { timeout: 2000 });
    console.log("Désinscrit de l'autorité");
  } catch (error) {
    console.log("Désinscription impossible : " + error.message);
  }
}

function estUneAdresse(texte) {
  return /^https?:\/\//.test(texte);
}

async function resoudre(destinataire) {
  if (!destinataire) return null;
  if (estUneAdresse(destinataire)) return nettoyer(destinataire);

  if (!annuaire[destinataire]) await annoncer();

  return annuaire[destinataire] ? annuaire[destinataire].url : null;
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
    viderFile(adresse);
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

async function envoyerSyn(to) {
  if (!MY_ID) return poster(to + "/syn");

  try {
    return await poster(to + "/broker/syn/" + encodeURIComponent(MY_ID));
  } catch (error) {
    if (error.response && error.response.status === 404) return poster(to + "/syn");
    throw error;
  }
}

async function envoyerRegister(to) {
  if (!MY_ID) return;

  try {
    await poster(to + "/register", { id: MY_ID, url: MY_URL });
  } catch (error) {
    console.log("Erreur en envoyant /register à " + to + " : " + error.message);
  }
}

async function poigneeDeMain(to) {
  const limite = Date.now() + DELAI_POIGNEE_DE_MAIN;

  enCours.add(to);
  try {
    console.log("SYN envoyé à " + to);
    await envoyerSyn(to);
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

function mettreEnFile(message) {
  fileAttente.push({ message: message, expiration: Date.now() + DUREE_FILE });
  console.log("Message pour " + message.metadata.target + " mis en file (" + DUREE_FILE / 60000 + " min)");
  return "mis en file";
}

async function viderFile(adresse) {
  const valides = fileAttente.filter((element) => element.expiration > Date.now());
  const aEnvoyer = valides.filter((element) => nettoyer(element.message.metadata.target) === adresse);
  fileAttente = valides.filter((element) => !aEnvoyer.includes(element));

  for (const element of aEnvoyer) {
    try {
      await posterAvecRetry(adresse + "/ingress", element.message);
      console.log("Message de la file envoyé à " + adresse);
    } catch (error) {
      fileAttente.push(element);
      console.log("Erreur en vidant la file vers " + adresse + " : " + error.message);
    }
  }
}

async function transmettre(message, origine) {
  const target = nettoyer(message.metadata.target);

  if (actives.includes(target)) {
    try {
      await posterAvecRetry(target + "/ingress", message);
      console.log("Message envoyé à " + target);
      return "envoyé";
    } catch (error) {
      console.log("Erreur en envoyant le message à " + target + " : " + error.message);
      return mettreEnFile(message);
    }
  }

  const voisins = actives.filter((adresse) => adresse !== origine);
  const envois = await Promise.allSettled(voisins.map((adresse) => posterAvecRetry(adresse + "/ingress", message)));

  if (!envois.some((envoi) => envoi.status === "fulfilled")) return mettreEnFile(message);

  console.log("Message pour " + target + " relayé à " + voisins.length + " voisin(s)");
  return "relayé";
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

function enregistrerId(req) {
  ajouterPair(req.params.id, req.headers.origin);
}

function poigneeDeMainConnue(req) {
  const from = nettoyer(req.headers.origin);
  return enCours.has(from) || actives.includes(from);
}

async function recevoirSyn(req, res, viaBroker) {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);

  console.log("SYN reçu de " + from);
  arreterSurveillance(from);
  enCours.add(from);
  res.sendStatus(202);

  try {
    console.log("SYN-ACK envoyé à " + from);
    await posterAvecRetry(from + "/syn-ack");
    if (viaBroker) await envoyerRegister(from);
  } catch (error) {
    enCours.delete(from);
    console.log("Poignée de main oubliée avec " + from + " : " + error.message);
  }
}

async function recevoirSynAck(req, res) {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!poigneeDeMainConnue(req)) return res.sendStatus(403);

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
}

function recevoirAck(req, res) {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!poigneeDeMainConnue(req)) return res.sendStatus(403);

  console.log("ACK reçu de " + from + " : connexion établie");
  activer(from);
  res.sendStatus(204);
}

app.post("/syn", (req, res) => recevoirSyn(req, res, false));
app.post("/syn-ack", recevoirSynAck);
app.post("/ack", recevoirAck);

app.post("/broker/syn/:id", (req, res) => {
  enregistrerId(req);
  return recevoirSyn(req, res, true);
});

app.post("/register", express.json(), (req, res) => {
  const { id, url } = req.body;
  if (typeof id !== "string" || id === "" || typeof url !== "string" || url === "") return res.sendStatus(400);

  console.log("Register reçu : " + id + " = " + url);
  ajouterPair(id, url);
  res.status(201).json(listeAnnuaire());
});

app.delete("/unregister/:id", (req, res) => {
  const id = req.params.id;
  if (!annuaire[id]) return res.sendStatus(404);

  console.log("Unregister reçu : " + id);
  delete annuaire[id];
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

app.post("/ingress", express.json(), async (req, res) => {
  const from = nettoyer(req.headers.origin);
  if (!from) return res.sendStatus(400);
  if (!actives.includes(from)) return res.sendStatus(403);
  if (!messageValide(req.body)) return res.sendStatus(400);

  const { action, metadata, payload } = req.body;
  const cle = cleMessage(metadata);
  if (vus.has(cle)) return res.sendStatus(208);
  vus.add(cle);

  if (nettoyer(metadata.target) === MY_URL) {
    MESSAGES.push({ from: from, date: Date.now(), action: action, metadata: metadata, payload: payload });
    console.log("Message reçu de " + metadata.source + " : " + JSON.stringify(payload));
    return res.sendStatus(201);
  }

  res.sendStatus(201);
  console.log("Message à relayer de " + metadata.source + " pour " + metadata.target);
  await transmettre({ action: action, metadata: metadata, payload: payload }, from);
});

app.get("/connexions", (req, res) => {
  res.json({ enCours: Array.from(enCours), actives: actives, inactives: inactives });
});

app.get("/messages", (req, res) => {
  res.json(MESSAGES);
});

app.get("/pairs", (req, res) => {
  res.json(listeAnnuaire());
});

app.post("/connect", express.json(), async (req, res) => {
  const to = await resoudre(req.body.to);
  if (!to) return res.status(404).send("Destinataire inconnu : " + req.body.to);

  const connecte = await poigneeDeMain(to);
  if (connecte) return res.send("Connexion établie avec " + to);
  res.status(502).send("Poignée de main impossible avec " + to);
});

app.post("/disconnect", express.json(), async (req, res) => {
  const to = await resoudre(req.body.to);
  if (!to) return res.status(404).send("Destinataire inconnu : " + req.body.to);

  console.log("On oublie " + to + " (envoi de /forget)");
  desactiver(to, "OUBLIE");
  try {
    await poster(to + "/forget");
  } catch (error) {
    console.log("Erreur en envoyant /forget à " + to + " : " + error.message);
  }

  res.send("Connexion avec " + to + " terminée");
});

app.post("/send", express.json(), async (req, res) => {
  const to = await resoudre(req.body.to);
  if (!to) return res.status(404).send("Destinataire inconnu : " + req.body.to);

  if (!actives.includes(to)) await poigneeDeMain(to);

  const message = creerMessage(to, req.body.action || "MESSAGES", req.body.content);
  const resultat = await transmettre(message, null);
  if (resultat === "relayé") mettreEnFile(message);
  res.send("Message " + resultat + " : " + to);
});

app.post("/broadcast", express.json(), async (req, res) => {
  const action = req.body.action || "MESSAGES";
  const resultats = {};

  await Promise.all(
    actives.slice().map(async (to) => {
      resultats[to] = await transmettre(creerMessage(to, action, req.body.content), null);
    })
  );

  res.json(resultats);
});

app.use((err, req, res, next) => {
  console.log("Erreur serveur : " + err.message);
  res.sendStatus(err.status || 500);
});

app.listen(PORT, () => {
  console.log("API démarrée sur " + MY_URL + (MY_ID ? " (" + MY_ID + ")" : ""));
  if (!MY_ID) console.log("Attention : MY_ID est vide dans le .env, la partie B (broker, prénoms) est désactivée");
  if (MY_ID && !AUTORITE_URL) console.log("Attention : AUTORITE_URL est vide dans le .env, pas d'inscription au broker");
  annoncer();
  setInterval(annoncer, DELAI_ANNONCE);
});

process.on("SIGINT", async () => {
  await desinscrire();
  process.exit(0);
});
