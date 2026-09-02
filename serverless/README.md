# Vigie — vérification de certificat (fonction serverless)

Le seul bout de code de tout le projet (voir [le cahier des charges technique](../docs/cahier-des-charges-technique.md#0-limite-à-connaître-avant-de-commencer)) : Make n'a pas de module natif pour lire l'expiration d'un certificat TLS, donc on ouvre la connexion nous-mêmes.

## Pourquoi Vercel et pas Cloudflare Workers

Le module natif Node `tls` donne un accès direct au certificat du pair (`socket.getPeerCertificate()`). L'API de sockets TLS de Cloudflare Workers, elle, ne redonne que le flux d'octets déchiffré — pas les métadonnées du certificat. Vercel fait tourner cette fonction sur un runtime Node.js classique, donc `tls` fonctionne tel quel.

## Tester en local (sans rien déployer)

```bash
node test-local.js github.com
```

Affiche le JSON `{ domain, expires_at, issued_at, issuer, subject, checked_at }`, ou une erreur explicite si le domaine ne répond pas.

## Déployer sur Vercel

```bash
npm install -g vercel   # une seule fois
vercel login            # une seule fois
vercel                  # depuis ce dossier serverless/
```

Puis dans les réglages du projet Vercel (Settings → Environment Variables), ajoutez :

- `VIGIE_API_KEY` — une clé secrète que vous choisissez (générez-en une avec `openssl rand -hex 32`, par exemple).

Redéployez ensuite (`vercel --prod`) pour que la variable soit prise en compte.

## Appeler la fonction

```
GET https://<votre-projet>.vercel.app/api/cert?domain=exemple.fr
Header: X-Vigie-Key: <la clé choisie ci-dessus>
```

Réponses possibles :

- `200` avec `{ domain, expires_at, issued_at, issuer, subject, checked_at }` — vérification réussie.
- `200` avec `{ domain, error, checked_at }` — vérification effectuée mais en échec (domaine injoignable, pas de certificat...). Volontairement un `200` : c'est un résultat métier, pas une erreur d'appel, et c'est ce que le scénario Make A doit lire pour mettre `Domaines.Statut certificat = erreur`.
- `400` — paramètre `domain` manquant ou mal formé.
- `401` — en-tête `X-Vigie-Key` manquant ou incorrect.

## Câblage dans Make

Dans le module HTTP du scénario A (vérification quotidienne) :

- Méthode : `GET`
- URL : `https://<votre-projet>.vercel.app/api/cert?domain={{nom_domaine}}`
- En-têtes : `X-Vigie-Key` → la clé, stockée dans un connecteur/variable Make plutôt qu'écrite en clair dans le scénario.
