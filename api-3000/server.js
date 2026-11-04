const express = require("express");
const axios = require("axios");

const PORT = 3000;
const MY_URL = "http://" + process.env.MY_IP + ":" + PORT;

const DELAI_PING = 5000;
const TIMEOUT_PING = 3000;
const MAX_ECHECS = 5;

const app = express();

const actives = [];
const inactives = {};
const minuteurs = {};

function envoyer(url) {
  axios.post(url, {}, { headers: { Origin: MY_URL } }).catch((error) => {
    console.log("Erreur en contactant " + url + " : " + error.message);
  });
}

function activer(adresse) {
  delete inactives[adresse];
  if (!actives.includes(adresse)) {
    actives.push(adresse);
    surveiller(adresse, 0);
  }
}

function desactiver(adresse, raison) {
  const position = actives.indexOf(adresse);
  if (position !== -1) actives.splice(position, 1);
  inactives[adresse] = raison;
  clearTimeout(minuteurs[adresse]);
  delete minuteurs[adresse];
}

function surveiller(adresse, echecs) {
  const delai = echecs === 0 ? DELAI_PING : 1000 * Math.pow(2, echecs - 1);

  minuteurs[adresse] = setTimeout(async () => {
    try {
      await axios.get(adresse + "/health", { timeout: TIMEOUT_PING });
      surveiller(adresse, 0);
    } catch (error) {
      echecs = echecs + 1;
      if (echecs >= MAX_ECHECS) {
        console.log(adresse + " ne répond plus (" + echecs + " échecs) : PERDU");
        desactiver(adresse, "PERDU");
      } else {
        console.log("Ping raté vers " + adresse + " (" + echecs + "/" + MAX_ECHECS + "), nouvel essai dans " + Math.pow(2, echecs - 1) + " s");
        surveiller(adresse, echecs);
      }
    }
  }, delai);
}

app.get("/connexions", (req, res) => {
  res.json({ actives: actives, inactives: inactives });
});

app.post("/connect", express.json(), (req, res) => {
  const to = req.body.to;

  console.log("SYN envoyé à " + to);
  envoyer(to + "/syn");

  res.send("SYN envoyé à " + to);
});

app.post("/disconnect", express.json(), (req, res) => {
  const to = req.body.to;

  console.log("On oublie " + to + " (envoi de /forget)");
  desactiver(to, "OUBLIE");
  envoyer(to + "/forget");

  res.send("Connexion avec " + to + " terminée");
});

app.post("/syn", (req, res) => {
  const from = req.headers.origin;

  console.log("SYN reçu de " + from);
  res.sendStatus(200);

  console.log("SYN-ACK envoyé à " + from);
  envoyer(from + "/syn-ack");
});

app.post("/syn-ack", (req, res) => {
  const from = req.headers.origin;

  console.log("SYN-ACK reçu de " + from);
  res.sendStatus(200);

  console.log("ACK envoyé à " + from);
  activer(from);
  envoyer(from + "/ack");
});

app.post("/ack", (req, res) => {
  const from = req.headers.origin;

  console.log("ACK reçu de " + from + " : connexion établie");
  activer(from);
  res.sendStatus(200);
});

app.get("/health", (req, res) => {
  res.sendStatus(200);
});

app.post("/forget", (req, res) => {
  const from = req.headers.origin;

  console.log(from + " nous a oubliés : OUBLIE");
  desactiver(from, "OUBLIE");
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("API démarrée sur " + MY_URL);
});
