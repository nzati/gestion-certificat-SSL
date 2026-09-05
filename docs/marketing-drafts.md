# Brouillons de diffusion — govigie.com

Rédigés le 2026-09-05, à ajuster avant publication (voix, longueur, actualité de l'offre). À poster manuellement — pas automatisé.

## LinkedIn (post perso, angle histoire vécue)

Il y a quelques années, un client m'a appelé un lundi matin : son site était down. Pas de hack, pas de panne serveur — juste un certificat SSL expiré pendant le week-end, personne n'avait vu passer l'alerte.

C'est le genre d'incident bête, évitable, mais qui arrive à tout le monde : agences, freelances, TPE qui gèrent leur propre site.

J'ai construit **Vigie** pour ça : une surveillance automatique des certificats SSL/TLS *et* des noms de domaine (l'autre angle mort — un domaine qui expire coupe tout, pas juste le HTTPS). Vérification quotidienne, alerte email des semaines avant l'échéance, pensé pour les agences qui gèrent plusieurs sites clients.

C'est en ligne : https://www.govigie.com — encore en liste d'attente, tarif fondateur pour les 100 premiers inscrits.

Si tu gères des sites clients (ou le tien) et que tu veux éviter le prochain appel du lundi matin, je suis preneur de retours 🙂

## IndieHackers (launch post, EN)

**Title:** Built a SaaS to stop SSL certs from expiring silently — mostly no-code, curious what surprised me

Expired SSL certs and domains are a boring, entirely avoidable failure mode — yet it still takes down sites every week (a client's site went down on a Monday morning because a cert expired over the weekend and nobody caught it).

**Vigie** (https://www.govigie.com) checks certificate + domain expiration daily and alerts by email weeks in advance. Built for agencies/MSPs managing multiple client sites, and solo devs/TPEs who just want to stop worrying about it.

Built almost entirely no-code (Airtable + Make + Softr), with one unavoidable exception: no no-code tool can open a raw TLS socket to read a cert's expiry date, so that one piece is a tiny serverless function. Also switched from a paid WHOIS API to RDAP (free, structured JSON) after realizing most modern registries support it — though a few TLDs (.de, .eu, .io) still don't expose it publicly, which was a fun rabbit hole.

Still pre-launch, building the waitlist. Would love feedback, especially from anyone managing certs for multiple domains today — what's your current process?

## Reddit (r/SaaS ou r/microsaas, ton plus low-key)

Built this after a client's site went down from an expired SSL cert nobody noticed over a weekend. Vigie checks cert + domain expiration daily and emails you weeks before it's a problem — mainly aimed at agencies juggling several client sites.

https://www.govigie.com — pre-launch waitlist right now. Would genuinely like to hear if this is a real pain for anyone here or if you've already got it solved some other way.

## Approche directe agences/MSP (email ou LinkedIn DM, court)

Bonjour [Prénom],

Je vois que [Nom agence] gère plusieurs sites clients — je te contacte parce que je viens de lancer un outil qui pourrait t'éviter un genre d'appel précis : celui du client dont le certificat SSL (ou le nom de domaine) a expiré sans que personne ne le voie venir.

Vigie (govigie.com) surveille tout ça automatiquement — un tableau de bord, une alerte par email des semaines avant l'échéance. Pensé pour les agences qui gèrent plusieurs domaines à la fois.

Encore en phase de liste d'attente, tarif fondateur pour les premiers inscrits. Ça t'intéresserait d'y jeter un œil ?
