# Vigie — vérification de certificat (fonction serverless)

Le seul bout de code de tout le projet (voir [le cahier des charges technique](../docs/cahier-des-charges-technique.md#0-limite-à-connaître-avant-de-commencer)) : Make n'a pas de module natif pour lire l'expiration d'un certificat TLS, donc on ouvre la connexion nous-mêmes.

## Pourquoi Vercel et pas Cloudflare Workers

Le module natif Node `tls` donne un accès direct au certificat du pair (`socket.getPeerCertificate()`). L'API de sockets TLS de Cloudflare Workers, elle, ne redonne que le flux d'octets déchiffré — pas les métadonnées du certificat. Vercel fait tourner cette fonction sur un runtime Node.js classique, donc `tls` fonctionne tel quel.

## Tester en local (sans rien déployer)

```bash
node test-local.js github.com
```

Affiche le JSON `{ domain, expires_at, issued_at, issuer, subject, checked_at }`, ou une erreur explicite si le domaine ne répond pas.

## Déployée

Projet Vercel `jacques8/serverless`, en production sur :

```
https://serverless-two-tau.vercel.app
```

La clé `VIGIE_API_KEY` est en variable d'environnement du projet Vercel (Settings → Environment Variables, valeur masquée) et en local dans `serverless/.env` (non versionné). Pas d'autre copie — si elle est perdue, il faut en régénérer une (`openssl rand -hex 32`) et la remettre à jour aux deux endroits, puis redéployer (`vercel --prod`).

Pour redéployer après une modification du code :

```bash
vercel --prod   # depuis ce dossier serverless/, une fois connecté (vercel login)
```

## Appeler la fonction

```
GET https://serverless-two-tau.vercel.app/api/cert?domain=exemple.fr
Header: X-Vigie-Key: <la clé, dans serverless/.env>
```

Réponses possibles :

- `200` avec `{ domain, expires_at, issued_at, issuer, subject, checked_at }` — vérification réussie.
- `200` avec `{ domain, error, checked_at }` — vérification effectuée mais en échec (domaine injoignable, pas de certificat...). Volontairement un `200` : c'est un résultat métier, pas une erreur d'appel, et c'est ce que le scénario Make A doit lire pour mettre `Domaines.Statut certificat = erreur`.
- `400` — paramètre `domain` manquant ou mal formé.
- `401` — en-tête `X-Vigie-Key` manquant ou incorrect.

## Câblage dans Make

Dans le module HTTP du scénario A (vérification quotidienne) :

- Méthode : `GET`
- URL : `https://serverless-two-tau.vercel.app/api/cert?domain={{nom_domaine}}`
- En-têtes : `X-Vigie-Key` → la clé, stockée dans un connecteur/variable Make plutôt qu'écrite en clair dans le scénario.
