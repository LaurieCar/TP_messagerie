const express = require("express");
const axios = require("axios");

const PORT = 3001;
const MY_URL = "http://localhost:" + PORT;

const app = express();
app.use(express.json());

const connexions = {};
const messages = [];
const sent = [];

app.get("/status", (req, res) => {
  res.json({ port: PORT, status: "ok" });
});

app.get("/connexions", (req, res) => {
  res.json(connexions);
});

app.post("/connect", async (req, res) => {
  const to = req.body.to;

  console.log("SYN envoyé à " + to);
  connexions[to] = "SYN_ENVOYE";
  const response = await axios.post(to + "/syn", { type: "SYN", from: MY_URL });

  console.log(response.data.type + " reçu de " + to);

  console.log("ACK envoyé à " + to);
  await axios.post(to + "/ack", { type: "ACK", from: MY_URL });
  connexions[to] = "CONNECTE";

  res.json({ message: "Connecté à " + to });
});

app.post("/syn", (req, res) => {
  console.log("SYN reçu de " + req.body.from);
  connexions[req.body.from] = "SYN_RECU";
  console.log("SYN-ACK envoyé à " + req.body.from);
  res.json({ type: "SYN-ACK", from: MY_URL });
});

app.post("/ack", (req, res) => {
  console.log("ACK reçu de " + req.body.from + " : connexion établie");
  connexions[req.body.from] = "CONNECTE";
  res.json({ message: "Connecté à " + req.body.from });
});

app.post("/messages", (req, res) => {
  console.log("Message reçu :", req.body);
  messages.push(req.body);
  res.json({ status: "reçu" });
});

app.get("/messages", (req, res) => {
  res.json(messages);
});

app.post("/send", async (req, res) => {
  const message = {
    from: MY_URL,
    content: req.body.content,
  };
  await axios.post(req.body.to + "/messages", message);
  sent.push(message);
  res.json({ status: "envoyé" });
});

app.get("/sent", (req, res) => {
  res.json(sent);
});

app.listen(PORT, () => {
  console.log("API démarrée sur " + MY_URL);
});
