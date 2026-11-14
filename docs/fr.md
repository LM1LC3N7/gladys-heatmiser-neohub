# Heatmiser neoHub

Ajoute à Gladys les zones thermostat d'un **neoHub Heatmiser**, sur votre réseau
local, par l'API locale officielle du hub (un WebSocket sécurisé sur le port
4243, authentifié par un jeton d'API du hub). Non officiel, sans lien avec
Heatmiser. **Jamais testé avec un vrai appareil pour l'instant** : écrit
d'après le document officiel « neoHub API » d'IMI Heatmiser ; vos retours sont
bienvenus.

## Ce que vous obtenez

- Un appareil par **zone thermostat** (neoStat, neoAir) : la température de la
  pièce, la consigne, et le mode : **Programme** (la zone suit son programme)
  ou **Veille** (hors gel : la zone tient sa température hors gel).
- Un appareil pour le **hub** : le **mode absence** (Présent / Absent). Absent
  met tous les thermostats en veille et coupe les horloges et les neoPlug (PDF
  de Heatmiser) : il agit sur tout ce que le hub pilote.
- Les horloges, les prises et la partie horloge d'un neoAir combiné ne sont pas
  affichées dans cette version.

## Mise en place

1. Dans l'app **Heatmiser Neo** : Paramètres > API Access > Tokens, créez un jeton.
2. Dans Gladys, ouvrez l'intégration : saisissez l'**adresse IP** du hub (visible
   dans votre box ; donnez-lui une adresse fixe) et le **jeton**, enregistrez.
3. Cliquez une fois sur **Tester la connexion**, **depuis votre réseau
   domestique** : le certificat présenté par le hub est lu et son empreinte
   **apprise** (affichée dans la réponse et dans le statut). Elle est apprise,
   **pas vérifiée** : le hub fabrique son propre certificat, aucune autorité ne
   permet de le contrôler. Quelqu'un qui contrôle votre réseau local à ce clic
   précis pourrait faire apprendre son propre certificat et recevoir le jeton.
   Pour vérifier, comparez l'empreinte affichée avec celle de votre hub, lue
   depuis un ordinateur de votre réseau : `openssl s_client -connect <adresse du
hub>:4243 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`.
   Vous pouvez aussi saisir l'empreinte vous-même au lieu de cliquer. Ensuite,
   le jeton ne part que vers ce certificat.
4. Ouvrez l'onglet **Découverte** et ajoutez les zones et le hub.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
seulement au hub à l'adresse saisie, sur le certificat appris. Il n'apparaît ni
dans les journaux, ni dans le statut, ni dans les fichiers de l'intégration.

## Commandes

La **Veille** d'une zone et l'**Absence** du hub ne demandent aucune option.
La veille ne fait que baisser le chauffage de sa zone ; l'absence met tous les
thermostats en veille et coupe les horloges et les neoPlug. Elles partent tout
de suite, avant toute autre commande en attente (une lecture du hub bloquée
depuis 1 s est coupée pour elles), adressées par le numéro d'appareil de la
zone ; les veilles d'une scène partent ensemble en une commande. Un hub qui
refuse les numéros reçoit tout de suite la zone par le nom que lui donne sa
dernière lecture (une commande par zone) ; un hub qui répond aux numéros sans
rien faire la reçoit par son nom au renvoi (environ 90 s plus tard, voir
plus bas). Dès qu'un nom a marché là où le numéro n'a pas marché, ce hub
reçoit des noms ensuite, même après un redémarrage ; une zone dont le nom
contient une apostrophe, un guillemet ou une barre oblique inverse part
toujours par son numéro. Gladys a sa réponse en 3,4 s environ ; un arrêt qui n'a pas pu partir
d'ici là reste dans la file et part dès que le hub est libre. Un arrêt est fait
dès qu'une lecture du hub le montre, et un changement fait ensuite dans l'app
l'emporte (jamais renvoyé). Le hub rafraîchit ses données environ toutes les
90 s : un arrêt auquel il a répondu est « pas encore visible » jusqu'à une
lecture partie au moins 90 s après sa réponse ; si cette lecture ne le montre
pas, ou si le hub n'a pas répondu, l'arrêt est renvoyé avec les prochaines
lectures (par numéro, et par nom quand le nom peut partir), 3 fois au plus, et
le statut et le badge de la zone le disent. Un changement fait dans l'app
pendant cette fenêtre ne se distingue pas d'un arrêt non appliqué : il peut
être écrasé, 3 fois au plus. Un Programme (ou Présent) plus
récent parti lève l'arrêt : il n'est plus renvoyé, même après un redémarrage.
Un Programme (ou Présent) refusé avant de partir (option désactivée, pause,
trop tard) laisse l'arrêt partir. Une commande demandée avant une mise en
veille de la même zone (avant une absence, sur toute zone) et pas encore partie
est annulée. Ce dont un arrêt a besoin malgré tout : l'adresse, le jeton et le
certificat appris (sans eux, rien ne peut partir vers le hub) ; il est refusé
quand un autre hub répond à l'adresse, et il n'est pas renvoyé tout seul après
un refus du jeton par le hub (un clic l'envoie, ou un nouveau jeton).

Ces commandes sont **désactivées par défaut** et demandent l'option
**Autoriser les commandes de chauffage** :

- la **consigne** d'une zone (de 5 °C au plafond, 24 °C par défaut, arrondi à
  0,5 °C vers le bas, par pas de 0,5 °C) ;
- **Programme** sur une zone (quitte la veille) ;
- **Présent** sur le hub (quitte le mode absence).

Chacune est décidée sur une lecture fraîche du hub (une lecture partie après
l'arrivée de la commande ; le hub, la zone à son numéro d'appareil et son nom à
la lecture précédente vérifiés), adressée par le numéro d'appareil de la zone,
envoyée en 2,8 s ou refusée sans envoi, puis relue quand aucune autre commande
n'attend ; Gladys a sa réponse en 3,4 s environ. La même consigne (ou le même
Programme) demandée à plusieurs zones à la fois part en une commande ; des
consignes différentes partent l'une après l'autre, chacune dans ses 2,8 s, les
autres refusées sans envoi (« trop tard »). Une consigne est refusée :

- quand l'option est désactivée, ou que la valeur sort de 5 °C au plafond ou
  n'est pas un multiple de 0,5 °C ;
- tant que la zone est en veille, absente ou en vacances, ou que le hub est
  absent ou en vacances (choisissez d'abord Programme ou Présent) ;
- pendant 10 minutes après une mise en veille de la zone ou une absence du hub,
  sauf si Programme ou Présent est parti depuis ;
- quand le hub est réglé en °F (seul le °C est pris en charge), ou que son unité
  n'est pas encore lue (de nouveau après tout changement du système du hub) ;
- quand la zone est hors ligne, disparue, ou renommée depuis la lecture
  précédente (réessayez) ; juste après un redémarrage, le nom gardé au Scan et
  une lecture de l'unité pendant la commande servent ;
- quand 8 commandes attendent déjà, pendant une pause après des lectures en
  échec, après un jeton refusé, ou quand son tour ne vient pas à temps (rien
  envoyé).

Programme et Présent sont refusés quand /data ne peut pas garder qu'ils lèvent
un arrêt (rien envoyé).

Une commande qui a pu atteindre le hub n'est jamais dite « pas envoyée » : vous
obtenez « envoyé, sans confirmation » et les prochaines lectures montrent le
résultat. Aucune commande ne passe par un interrupteur : un « tout éteindre »
n'atteint jamais le chauffage.

## Lectures et rythme

Le hub est lu toutes les 60 s par défaut (30 à 600 s ; le hub rafraîchit ses
propres données environ toutes les 90 s) ; le bouton, l'onglet Découverte ou un
redémarrage ne le lisent jamais avant l'intervalle. Une commande ajoute ses
propres lectures : une avant elle, une juste après, puis 5 s et 20 s plus tard. Après un échec,
l'intégration attend 1, 2, 5, 10 puis 15 minutes. Un jeton refusé par le hub
arrête les lectures automatiques jusqu'à un nouveau jeton ou un clic sur
Tester la connexion.

Si le hub est remplacé ou réinitialisé, son certificat change : rien n'est
envoyé et le statut montre la nouvelle empreinte ; saisissez-la dans la
configuration après avoir vérifié qu'il s'agit bien de votre hub.

## Données

`/data/heatmiser-neohub-state.json` garde l'heure de la dernière lecture, la
pause, les empreintes de certificat apprises, les commandes d'arrêt encore à
envoyer et, pour un jeton refusé, une étiquette de 8 bits (jamais le jeton).
