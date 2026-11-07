# TP Messagerie

On n'utilise pas de WebSocket : tous les échanges passent par des requêtes HTTP qui suivent le protocole commun défini avec le reste de la classe.

- `api-3000` et `api-3001` : deux serveurs identiques, seul le port change.
- `TP_messagerie/` : notre collection Bruno.
- Le broker (annuaire) est dans un autre dépôt : https://github.com/Naudrey974/autorit-_centrale_tp_messagerie

## Lancer le projet

Dans chaque dossier `api-3000` et `api-3001`, on copie `.env.example` en `.env` et on le remplit :

```
MY_ID=Audrey
MY_IP=192.168.1.191
AUTORITE_URL=http://localhost:4000
# MY_URL=https://mon-tunnel.devtunnels.ms
```

- `MY_ID` : notre prénom, qui sert d'identifiant.
- `MY_IP` : l'IP de la machine. On peut la remplacer par `MY_URL` si on passe par un tunnel.
- `AUTORITE_URL` : l'adresse du broker.

On lance d'abord le broker, puis les deux serveurs :

```bash
cd api-3000 && npm install && npm start
cd api-3001 && npm install && npm start
```

Pour tester sur une seule machine, on met `MY_URL=http://localhost:3000` (et `3001` pour l'autre).

## Le protocole

Toutes les requêtes ont un timeout de 15 s. Chaque serveur indique son adresse dans l'en-tête `Origin`.

### Partie A : connexion entre deux serveurs

**Poignée de main**

```
A -> B   POST /syn       Origin: A   -> 202
B -> A   POST /syn-ack   Origin: B   -> 202
A -> B   POST /ack       Origin: A   -> 204   (connexion établie)
```

`/syn-ack` et `/ack` sont réessayés en cas d'échec : 5 essais, avec 1, 2, 4 puis 8 s d'attente.

**Keep-alive**

Chaque serveur envoie `GET /health` à ses connexions toutes les 5 s. Celui qui reçoit répond `202` et renvoie un `POST /pong`.

On perd la connexion (`PERDU`) si `/health` échoue 5 fois de suite, ou si 5 pings restent sans `/pong`.

**Oubli**

`POST /forget` ferme la connexion des deux côtés (`OUBLIE`).

**Messages**

`POST /ingress`, accepté seulement si l'expéditeur est connecté :

```json
{
  "action": "MESSAGES",
  "metadata": {
    "source": "http://localhost:3000",
    "target": "http://localhost:3001",
    "timestamp": "2026-11-07T10:00:00.000Z"
  },
  "payload": { "message": "Salut" }
}
```

Réponses : `201` créé, `208` déjà reçu (même `source` et même `timestamp`), `400` mal formé, `403` pas connecté.

### Partie B : le broker

Le broker sert d'annuaire, comme un DNS : il retient les `id = url`, mais ne transmet aucun message.

- Au démarrage, puis toutes les 30 s, chaque serveur envoie `POST /register` avec `{ "id": "Audrey", "url": "http://..." }`.
- Le broker répond avec la liste des pairs en ligne, et prévient les autres serveurs par un `POST /register`.
- À l'arrêt (`Ctrl + C`), le serveur envoie `DELETE /unregister/{id}`, et le broker prévient les autres.

Ça permet d'écrire à quelqu'un par son prénom : le serveur retrouve l'URL dans son annuaire.

Si un serveur ne peut pas joindre la cible, il transmet le message à ses autres connexions (relais). S'il n'a personne à qui le transmettre, il le garde 2 minutes et l'envoie dès que la cible se connecte.

### Partie C : prénom et chiffrement

**Poignée de main avec prénom**

```
A -> B   POST /broker/syn/A   Origin: A                  B retient A = url de A
B -> A   POST /syn-ack        Origin: B
B -> A   POST /register       { "id": "B", "url": ... }  A retient B = url de B
A -> B   POST /ack            Origin: A
```

**Clé publique et chiffrement**

Chaque requête porte la clé publique X25519 du serveur :

```
Signature-Input: sig1=();keyid="<clé publique en base64url>"
```

- Sans en-tête, ou avec une clé invalide : `401`.
- Si un serveur connu présente une autre clé : `403`.
- À la poignée de main, les deux serveurs calculent un secret commun, qui sert à chiffrer le `payload`.

## Routes

Les routes du protocole, appelées par les autres serveurs :

- `POST /syn`, `POST /syn-ack` et `POST /ack` servent à la poignée de main.
- `POST /broker/syn/{id}` fait la même chose, en donnant en plus son prénom.
- `GET /health` et `POST /pong` vérifient que la connexion est toujours là.
- `POST /forget` ferme une connexion.
- `POST /ingress` reçoit un message.
- `POST /register` et `DELETE /unregister/{id}` mettent à jour l'annuaire.

Nos routes outils, qu'on appelle nous-mêmes sur notre serveur (elles ne font pas partie du protocole) :

- `POST /connect` lance une poignée de main : `{ "to": "Laurie" }`.
- `POST /disconnect` ferme une connexion et prévient l'autre avec `/forget` : `{ "to": "Laurie" }`.
- `POST /send` envoie un message : `{ "to": "Laurie", "content": { "message": "Salut" } }`.
- `POST /broadcast` écrit à toutes nos connexions : `{ "content": { "message": "Salut" } }`.
- `GET /connexions` montre les connexions en cours, actives et inactives.
- `GET /messages` montre les messages reçus.
- `GET /pairs` montre notre annuaire.

Dans `to`, on peut mettre un prénom ou une URL.

## Choix faits là où le protocole ne précise rien

Ces points sont aussi commentés dans `api-3000/server.js` :

- La paire de clés X25519 est créée à chaque démarrage, rien n'est enregistré sur le disque.
- `/health`, `/register` et `/unregister` n'exigent pas l'en-tête `Signature-Input` : le broker n'a pas de clé, et `/health` se fait sans vérification.
- Le secret X25519 passe par HKDF-SHA256 pour donner une clé AES-256.
- Le `payload` est chiffré en AES-256-GCM et envoyé sous la forme `{ "iv": ..., "data": ..., "tag": ... }`.
- Le chiffrement se fait de serveur à serveur : un relais déchiffre puis rechiffre pour le suivant.
- La clé d'un pair est oubliée en même temps que la connexion, pour qu'un serveur redémarré puisse se reconnecter.

## Tester avec Bruno

On ouvre le dossier `TP_messagerie/` dans Bruno et on choisit l'environnement `local` (`A`, `B`, `AUTORITE`).

Depuis la partie C, les requêtes envoyées à la main sur les routes du protocole répondent `401` si elles n'ont pas d'en-tête `Signature-Input`. Les routes outils et `/health`, `/register`, `/unregister` ne sont pas concernées.

## Limites

- Pas de double ratchet ni de rotation des clés : la clé reste la même pendant toute la connexion.
- Un relais peut lire les messages qu'il transmet.
- Pas de vérification d'identité : n'importe qui peut utiliser un prénom.
- Pas de failover par le broker.
- Pas de simulateur de perte ou de latence.
- Tout est gardé en mémoire : les connexions, l'annuaire et les messages sont perdus au redémarrage.
