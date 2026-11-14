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
  met toutes les zones en veille.
- Les horloges, les prises et la partie horloge d'un neoAir combiné ne sont pas
  affichées dans cette version.

## Mise en place

1. Dans l'app **Heatmiser Neo** : Paramètres > API Access > Tokens, créez un jeton.
2. Dans Gladys, ouvrez l'intégration : saisissez l'**adresse IP** du hub (visible
   dans votre box ; donnez-lui une adresse fixe) et le **jeton**, enregistrez.
3. Cliquez une fois sur **Tester la connexion** : le certificat présenté par le
   hub est lu et confirmé (son empreinte s'affiche). Ensuite, le jeton ne part
   que vers ce certificat. Vous pouvez aussi saisir vous-même l'empreinte SHA-256.
4. Ouvrez l'onglet **Découverte** et ajoutez les zones et le hub.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
seulement au hub à l'adresse saisie, sur son certificat confirmé. Il n'apparaît
ni dans les journaux, ni dans le statut, ni dans les fichiers de l'intégration.

## Commandes

La **Veille** d'une zone et l'**Absence** du hub ne font que baisser le
chauffage : elles sont permises quelles que soient les options, et
partent tout de suite, avant toute autre commande en attente (une lecture du
hub bloquée depuis 1 s est coupée pour elles). Si l'une ne peut pas partir, ou
si le hub ne la montre pas encore, elle est renvoyée avec les prochaines
lectures du hub, 3 fois au plus. Une commande demandée avant une mise en veille
de la même zone (avant une absence, sur toute zone) et pas encore partie est
annulée. Ce dont une veille ou une absence a besoin malgré tout : l'adresse, le
jeton et le certificat confirmé (sans eux, rien ne peut partir vers le hub).
Une veille est aussi refusée quand le nom de la zone n'est pas encore connu ou
contient une apostrophe ou une barre oblique inverse, et les deux sont refusées
quand un autre hub répond à l'adresse.

Ces commandes sont **désactivées par défaut** et demandent l'option
**Autoriser les commandes de chauffage** :

- la **consigne** d'une zone (de 5 °C au plafond, 24 °C par défaut, par pas de
  0,5 °C) ;
- **Programme** sur une zone (quitte la veille) ;
- **Présent** sur le hub (quitte le mode absence).

Chacune est décidée sur une lecture fraîche du hub (le hub et la zone vérifiés :
une zone renommée dans l'app est de nouveau commandée une fois l'appareil mis à
jour depuis l'onglet Découverte), envoyée en 3,5 s ou refusée sans envoi, puis
relue. Une consigne est refusée :

- quand l'option est désactivée, ou que la valeur sort de 5 °C au plafond ou
  n'est pas un multiple de 0,5 °C ;
- tant que la zone est en veille, absente ou en vacances, ou que le hub est
  absent ou en vacances (choisissez d'abord Programme ou Présent) ;
- pendant 10 minutes après une mise en veille de la zone ou une absence du hub,
  sauf si Programme ou Présent a été choisi depuis ;
- quand le hub est réglé en °F (seul le °C est pris en charge), ou que son unité
  n'est pas encore lue ;
- quand la zone est hors ligne, renommée, disparue, ou que son nom contient une
  apostrophe ou une barre oblique inverse ;
- quand 8 commandes attendent déjà, pendant une pause après des lectures en
  échec, après un jeton refusé, ou quand le hub est trop lent (rien envoyé).

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
pause, les empreintes de certificat confirmées, les commandes d'arrêt encore à
envoyer et, pour un jeton refusé, une étiquette de 8 bits (jamais le jeton).
