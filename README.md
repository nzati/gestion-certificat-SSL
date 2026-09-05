# Vigie — Surveillance de certificats SSL/TLS et de noms de domaine

Micro-SaaS de surveillance d'expiration de certificats SSL/TLS et de noms de domaine, ciblé TPE/PME et agences/MSP françaises.

Stack : Airtable (données) + Make (automatisations) + Softr (portail client) + Vercel (landing page + la seule fonction de code du projet) + Stripe (facturation, pas encore branché).

## En ligne

| | |
|---|---|
| Landing page | https://www.govigie.com |
| Portail client | https://app.govigie.com |
| `.fr` / `.info` / `.store` | redirigent vers `www.govigie.com` |

## Contenu du dépôt

- [`landing/index.html`](landing/index.html) — landing page, déployée sur Vercel.
- [`serverless/`](serverless/README.md) — fonction de vérification de certificat TLS, déployée sur Vercel.
- [`scripts/`](scripts/README.md) — scripts ayant servi à construire la base Airtable et les scénarios Make par API, avec le détail de chaque découverte/piège rencontré.
- [`docs/cahier-des-charges-technique.md`](docs/cahier-des-charges-technique.md) — schéma Airtable, scénarios Make, flow Softr, état d'avancement de chaque brique.

## Statut

Cœur du produit construit et testé en conditions réelles : vérification quotidienne (scénario A), ajout de domaine via le portail (scénario B), synchronisation Stripe (scénario D, testé avec des événements simulés faute de compte Stripe réel), portail Softr connecté à Airtable. Restent : scénario C (rapport PDF mensuel), Slack/SMS, connexion Stripe réelle, pages Agence/MSP.
