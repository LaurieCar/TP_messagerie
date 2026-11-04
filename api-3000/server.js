const express = require("express");
const axios = require("axios");

const PORT = 3000;
const MY_URL = "http://" + process.env.MY_IP + ":" + PORT;

const app = express();

const connexions = {};

function envoyer(url) {
  axios.post(url, {}, { headers: { Origin: MY_URL } }).catch((error) => {
    console.log("Erreur en contactant " + url + " : " + error.message);
  });
}

app.get("/connexions", (req, res) => {
  res.json(connexions);
});

app.post("/connect", express.json(), (req, res) => {
  const to = req.body.to;

  console.log("SYN envoyé à " + to);
  connexions[to] = "SYN_ENVOYE";
  envoyer(to + "/syn");

  res.send("SYN envoyé à " + to);
});

app.post("/syn", (req, res) => {
  const from = req.headers.origin;

  console.log("SYN reçu de " + from);
  connexions[from] = "SYN_RECU";
  res.sendStatus(200);

  console.log("SYN-ACK envoyé à " + from);
  envoyer(from + "/syn-ack");
});

app.post("/syn-ack", (req, res) => {
  const from = req.headers.origin;

  console.log("SYN-ACK reçu de " + from);
  res.sendStatus(200);

  console.log("ACK envoyé à " + from);
  connexions[from] = "CONNECTE";
  envoyer(from + "/ack");
});

app.post("/ack", (req, res) => {
  const from = req.headers.origin;

  console.log("ACK reçu de " + from + " : connexion établie");
  connexions[from] = "CONNECTE";
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("API démarrée sur " + MY_URL);
});
