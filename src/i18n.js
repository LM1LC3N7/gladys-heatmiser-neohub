// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French. Never the token, never the
// address of the hub.
// -----------------------------------------------------------------------------

import { AWAY, FEATURES as F, MODES } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "45 s" / "25 min" / "3 h", for the waits (59.99 s is "1 min", never "60 s"). */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [F.TEMPERATURE]: both('Temperature', 'Température'),
  [F.TARGET]: both('Setpoint', 'Consigne'),
  [F.MODE]: both('Mode', 'Mode'),
  [F.AWAY]: both('Away mode', 'Mode absence'),
};

export const MODE_NAMES = {
  [MODES.SCHEDULE]: both('Schedule', 'Programme'),
  [MODES.STANDBY]: both('Standby (frost protection)', 'Veille (hors gel)'),
};

export const AWAY_NAMES = {
  [AWAY.HOME]: both('Home', 'Présent'),
  [AWAY.AWAY]: both(
    'Away (thermostats in standby, time clocks off)',
    'Absent (thermostats en veille, horloges coupées)',
  ),
};

export const hubName = both('neoHub', 'neoHub');

/** "Living room (neoHub)" / "Zone 3 (neoHub)". */
export const zoneName = (name, id) =>
  name
    ? both(`${name.slice(0, 60)} (neoHub)`, `${name.slice(0, 60)} (neoHub)`)
    : both(`Zone ${id} (neoHub)`, `Zone ${id} (neoHub)`);

/** The reason of a failure, in each language. */
export function reasonOf(err) {
  switch (err?.kind) {
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'late':
      return both('too late to send', 'trop tard pour envoyer');
    case 'network':
    case 'closed':
      return both(`network: ${err.message}`, `réseau : ${err.message}`);
    case 'size':
      return both('answer too large', 'réponse trop grande');
    case 'nopin':
      return both('certificate not known yet', 'certificat pas encore connu');
    case 'pin':
      return both('the certificate of the hub changed', 'le certificat du hub a changé');
    case 'token':
      return both('token refused by the hub', 'jeton refusé par le hub');
    case 'hub':
      return both(`the hub answered: ${err.text ?? '?'}`, `le hub a répondu : ${err.text ?? '?'}`);
    case 'identity':
      return both('hub identity unreadable', 'identité du hub illisible');
    case 'protocol':
      return both('unexpected answer', 'réponse inattendue');
    case 'cut':
      return both('cut for a standby', 'coupé pour une mise en veille');
    case 'stopped':
      return both('stopped', 'arrêté');
    default:
      return both('internal error', 'erreur interne');
  }
}

export const T = {
  noConfig: both(
    'Type the address of your neoHub and its API token (Heatmiser Neo app: Settings > API Access > Tokens).',
    'Saisissez l’adresse de votre neoHub et son jeton d’API (app Heatmiser Neo : Paramètres > API Access > Tokens).',
  ),
  configError: {
    path: both(
      'The address holds a path or a query: type only the IP address of the hub, like 192.168.1.40.',
      'L’adresse contient un chemin ou une requête : saisissez seulement l’adresse IP du hub, par exemple 192.168.1.40.',
    ),
    invalid: both(
      'The address is not an IP address nor a host name.',
      'L’adresse n’est ni une adresse IP ni un nom d’hôte.',
    ),
    broadcast: both(
      'This address is a broadcast or multicast address, not a hub.',
      'Cette adresse est une adresse de diffusion ou de multidiffusion, pas un hub.',
    ),
    'local-name': both(
      'A .local name does not resolve in the container: type the IP address of the hub.',
      'Un nom en .local ne se résout pas dans le conteneur : saisissez l’adresse IP du hub.',
    ),
    fingerprint: both(
      'The certificate fingerprint is not a SHA-256 one (64 hexadecimal digits).',
      'L’empreinte du certificat n’est pas une empreinte SHA-256 (64 chiffres hexadécimaux).',
    ),
    token: both(
      'The API token holds unexpected characters (spaces, quotes): copy it again from the Heatmiser Neo app.',
      'Le jeton d’API contient des caractères inattendus (espaces, guillemets) : copiez-le à nouveau depuis l’app Heatmiser Neo.',
    ),
  },
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; new try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  connecting: both('Connecting to the neoHub…', 'Connexion au neoHub…'),
  noPin: both(
    'The certificate of the hub is not known yet: click "Test the connection" from your home network (or type its fingerprint). Nothing is sent before.',
    'Le certificat du hub n’est pas encore connu : cliquez sur « Tester la connexion » depuis votre réseau domestique (ou saisissez son empreinte). Rien n’est envoyé avant.',
  ),
  learnt: (fp) =>
    both(
      `Certificate fingerprint learnt on the first click, not verified: ${fp}. Compare it with the one of your hub (see the guide).`,
      `Empreinte du certificat apprise au premier clic, non vérifiée : ${fp}. Comparez-la avec celle de votre hub (voir le guide).`,
    ),
  pinChanged: (fp) =>
    both(
      `The certificate of the hub changed: nothing is sent (seen: ${fp ?? '?'}). If you replaced or reset the hub, type this fingerprint in the configuration.`,
      `Le certificat du hub a changé : rien n’est envoyé (vu : ${fp ?? '?'}). Si vous avez remplacé ou réinitialisé le hub, saisissez cette empreinte dans la configuration.`,
    ),
  tokenRefused: both(
    'The hub refused the API token: no automatic read until you type a new token or click "Test the connection".',
    'Le hub a refusé le jeton d’API : plus de lecture automatique jusqu’à un nouveau jeton ou un clic sur « Tester la connexion ».',
  ),
  unreachable: (reason, wait) =>
    both(
      `neoHub not reached (${reason.en}); new try in ${wait.en}.`,
      `neoHub non joint (${reason.fr}) ; nouvel essai dans ${wait.fr}.`,
    ),
  noZone: both(
    'Connected: no thermostat zone on the hub.',
    'Connecté : aucune zone thermostat sur le hub.',
  ),
  connected: (n) =>
    both(`Connected: ${n} zone${n > 1 ? 's' : ''}.`, `Connecté : ${n} zone${n > 1 ? 's' : ''}.`),
  fahrenheit: both(
    'The hub is set to °F: temperatures are not shown and setpoints are refused (only °C is supported).',
    'Le hub est réglé en °F : les températures ne sont pas affichées et les consignes sont refusées (seul le °C est pris en charge).',
  ),
  unitUnknown: both(
    'Unit of the hub not read yet: temperatures wait for it.',
    'Unité du hub pas encore lue : les températures l’attendent.',
  ),
  offlineZones: (list) => both(`Offline: ${list.en}.`, `Hors ligne : ${list.fr}.`),
  duplicates: both(
    'Two zones share an id: neither is shown.',
    'Deux zones partagent un identifiant : aucune n’est affichée.',
  ),
  notApplied: (list) =>
    both(
      `Last command not shown by the hub: ${list.en}.`,
      `Dernière commande pas visible dans le hub : ${list.fr}.`,
    ),
  guardContradicted: (list) =>
    both(
      `Answered by the hub but not applied (sent again): ${list.en}.`,
      `Répondu par le hub mais pas appliqué (renvoyé) : ${list.fr}.`,
    ),
  guardNotVisible: both(
    'A standby or an away answered by the hub is not yet visible in its data (refreshed about every 90 s).',
    'Une mise en veille ou une absence répondue par le hub n’est pas encore visible dans ses données (rafraîchies environ toutes les 90 s).',
  ),
  guardPending: both(
    'A standby or an away was not answered by the hub yet: it is sent again with the next reads.',
    'Une mise en veille ou une absence n’a pas encore eu de réponse du hub : elle est renvoyée avec les prochaines lectures.',
  ),
  andMore: (n) => both(` and ${n} more`, ` et ${n} de plus`),
  hub: both('the hub', 'le hub'),
  test: {
    busy: both(
      'A read is in progress: try again in a few seconds.',
      'Une lecture est en cours : réessayez dans quelques secondes.',
    ),
    wait: (wait) =>
      both(
        `Next read in ${wait.en} (never sooner than the interval).`,
        `Prochaine lecture dans ${wait.fr} (jamais avant l’intervalle).`,
      ),
    slow: both(
      'The hub is slow to answer: the status will tell the result.',
      'Le hub tarde à répondre : le statut donnera le résultat.',
    ),
    noCertificate: (reason) =>
      both(
        `The hub did not show its certificate (${reason.en}): check the address.`,
        `Le hub n’a pas présenté son certificat (${reason.fr}) : vérifiez l’adresse.`,
      ),
    pinned: (fp) =>
      both(
        `Fingerprint of the certificate learnt, not verified: ${fp}. From now on the token goes to this certificate only; compare it with the one of your hub (see the guide).`,
        `Empreinte du certificat apprise, non vérifiée : ${fp}. Désormais le jeton n’est envoyé qu’à ce certificat ; comparez-la avec celle de votre hub (voir le guide).`,
      ),
    pinNotSaved: (fp) =>
      both(
        `Certificate seen (${fp}) but /data could not keep it: type this fingerprint in the configuration.`,
        `Certificat vu (${fp}) mais /data n’a pas pu le garder : saisissez cette empreinte dans la configuration.`,
      ),
    memoryUnreadable: both(
      '/data cannot be read: type the fingerprint of the certificate in the configuration.',
      '/data est illisible : saisissez l’empreinte du certificat dans la configuration.',
    ),
  },
};

export const ERRORS = {
  readOnly: both('This feature cannot be changed.', 'Cette fonction ne peut pas être modifiée.'),
  configNotLoaded: both(
    'The configuration is not read yet: try again in a moment.',
    'La configuration n’est pas encore lue : réessayez dans un instant.',
  ),
  heatingDisabled: both(
    'Not sent: heating commands are off (option "Allow heating commands"). Standby and away need no option.',
    'Pas envoyé : les commandes de chauffage sont désactivées (option « Autoriser les commandes de chauffage »). La veille et l’absence ne demandent aucune option.',
  ),
  queueFull: (n) =>
    both(
      `Not sent: ${n} commands already wait for the hub.`,
      `Pas envoyé : ${n} commandes attendent déjà le hub.`,
    ),
  badOption: both('Not sent: unknown choice.', 'Pas envoyé : choix inconnu.'),
  badNumber: both(
    'Not sent: the setpoint is not a number.',
    'Pas envoyé : la consigne n’est pas un nombre.',
  ),
  badStep: both(
    'Not sent: the setpoint goes by steps of 0.5 °C.',
    'Pas envoyé : la consigne va par pas de 0,5 °C.',
  ),
  outOfRange: (min, max) =>
    both(
      `Not sent: the setpoint must be between ${min} and ${max} °C.`,
      `Pas envoyé : la consigne doit être entre ${min} et ${String(max).replace('.', ',')} °C.`,
    ),
  stopped: both(
    'Not sent: the integration is restarting.',
    'Pas envoyé : l’intégration redémarre.',
  ),
  cancelledByStandby: both(
    'Not sent: a standby of this zone was asked after it.',
    'Pas envoyé : une mise en veille de cette zone a été demandée après.',
  ),
  cancelledByAway: both(
    'Not sent: the away mode was asked after it.',
    'Pas envoyé : le mode absence a été demandé après.',
  ),
  standbyGuard: both(
    'Not sent: this zone was put in standby less than 10 minutes ago; choose "Schedule" first.',
    'Pas envoyé : cette zone a été mise en veille il y a moins de 10 minutes ; choisissez d’abord « Programme ».',
  ),
  awayGuard: both(
    'Not sent: the away mode was asked less than 10 minutes ago; choose "Home" first.',
    'Pas envoyé : le mode absence a été demandé il y a moins de 10 minutes ; choisissez d’abord « Présent ».',
  ),
  notScheduled: both(
    'Not sent: the zone is in standby, away or on holiday (or the hub does not say); choose "Schedule" or "Home" first.',
    'Pas envoyé : la zone est en veille, absente ou en vacances (ou le hub ne le dit pas) ; choisissez d’abord « Programme » ou « Présent ».',
  ),
  tokenRefused: both(
    'Not sent: the hub refused the API token.',
    'Pas envoyé : le hub a refusé le jeton d’API.',
  ),
  tokenRefusedSent: both(
    'Refused by the hub: it does not accept the API token.',
    'Refusé par le hub : il n’accepte pas le jeton d’API.',
  ),
  paused: both(
    'Not sent: the hub did not answer the last reads (pause in progress).',
    'Pas envoyé : le hub n’a pas répondu aux dernières lectures (pause en cours).',
  ),
  fahrenheit: both(
    'Not sent: the hub is set to °F (only °C is supported).',
    'Pas envoyé : le hub est réglé en °F (seul le °C est pris en charge).',
  ),
  unitUnknown: both(
    'Not sent: the unit of the hub is not read yet.',
    'Pas envoyé : l’unité du hub n’est pas encore lue.',
  ),
  queueLate: (n) =>
    both(
      `Not sent: ${n} command${n > 1 ? 's' : ''} before it took its time.`,
      `Pas envoyé : ${n} commande${n > 1 ? 's' : ''} avant elle ont pris son temps.`,
    ),
  tooSlow: both(
    'Not sent: the hub is too slow to answer.',
    'Pas envoyé : le hub est trop lent à répondre.',
  ),
  otherHub: both(
    'Not sent: another hub answers at this address.',
    'Pas envoyé : un autre hub répond à cette adresse.',
  ),
  zoneGone: both(
    'Not sent: this zone is not on the hub any more.',
    'Pas envoyé : cette zone n’est plus sur le hub.',
  ),
  zoneRenamed: both(
    'Not sent: the zone was renamed on the hub since the last read; try again.',
    'Pas envoyé : la zone a été renommée sur le hub depuis la dernière lecture ; réessayez.',
  ),
  zoneNotRead: both(
    'Not sent: the zone has not been read yet; try again after the next read.',
    'Pas envoyé : la zone n’a pas encore été lue ; réessayez après la prochaine lecture.',
  ),
  liftNotSaved: both(
    'Not sent: /data could not keep that the standby (or away) is lifted.',
    'Pas envoyé : /data n’a pas pu garder la levée de la veille (ou de l’absence).',
  ),
  liftedBefore: both(
    'Not sent: a newer "Schedule" or "Home" left before it.',
    'Pas envoyé : un « Programme » ou « Présent » plus récent est parti avant.',
  ),
  protectiveSending: both(
    'Being sent: the hub has not answered yet; it leaves as soon as the hub is free, then the next reads show it.',
    'En cours d’envoi : le hub n’a pas encore répondu ; il part dès que le hub est libre, puis les prochaines lectures le montrent.',
  ),
  protectiveWaiting: both(
    'Sent; waiting for the answer of the hub: the next reads will show it.',
    'Envoyé ; en attente de la réponse du hub : les prochaines lectures le montreront.',
  ),
  protectiveContradicted: both(
    'Answered by the hub, but its data still does not show it 90 s later: sent again with the next reads (3 times at most).',
    'Répondu par le hub, mais ses données ne le montrent toujours pas 90 s plus tard : renvoyé avec les prochaines lectures (3 fois au plus).',
  ),
  protectiveAccepted: both(
    'Sent and answered by the hub; not yet visible in its data (refreshed about every 90 s): sent again if a read 90 s later does not show it.',
    'Envoyé et répondu par le hub ; pas encore visible dans ses données (rafraîchies environ toutes les 90 s) : renvoyé si une lecture 90 s plus tard ne le montre pas.',
  ),
  zoneOffline: both(
    'Not sent: the thermostat is offline.',
    'Pas envoyé : le thermostat est hors ligne.',
  ),
  noPin: both(
    'Not sent: the certificate of the hub is not known yet (click "Test the connection").',
    'Pas envoyé : le certificat du hub n’est pas encore connu (cliquez sur « Tester la connexion »).',
  ),
  pinChanged: both(
    'Not sent: the certificate of the hub changed (see the status of the integration).',
    'Pas envoyé : le certificat du hub a changé (voir le statut de l’intégration).',
  ),
  unknownState: (reason) =>
    both(
      `Not sent: the state of the hub could not be read (${reason.en}).`,
      `Pas envoyé : l’état du hub n’a pas pu être lu (${reason.fr}).`,
    ),
  notSent: (reason) => both(`Not sent (${reason.en}).`, `Pas envoyé (${reason.fr}).`),
  refusedByHub: (text) =>
    both(
      `The hub refused the command (${text ?? '?'}).`,
      `Le hub a refusé la commande (${text ?? '?'}).`,
    ),
  unconfirmed: both(
    'Sent, without confirmation from the hub: the next reads will show it.',
    'Envoyé, sans confirmation du hub : les prochaines lectures le montreront.',
  ),
  verifyLater: both(
    'Sent; the hub has not shown it yet: the next reads will tell.',
    'Envoyé ; le hub ne le montre pas encore : les prochaines lectures le diront.',
  ),
  notAppliedNow: (read, wanted) =>
    both(
      `Sent, but the hub still shows ${read.en} (asked: ${wanted.en}).`,
      `Envoyé, mais le hub montre encore ${read.fr} (demandé : ${wanted.fr}).`,
    ),
  notShownYet: both(
    'Sent, but the hub does not show it yet: the next reads will tell.',
    'Envoyé, mais le hub ne le montre pas encore : les prochaines lectures le diront.',
  ),
  protectiveUnconfirmed: both(
    'Sent, without an answer from the hub: sent again with the next reads (3 times at most) until the hub answers or shows it.',
    'Envoyé, sans réponse du hub : renvoyé avec les prochaines lectures (3 fois au plus) jusqu’à ce que le hub réponde ou le montre.',
  ),
  protectiveLater: both(
    'Not sent now: sent again with the next reads (3 times at most).',
    'Pas envoyé pour l’instant : renvoyé avec les prochaines lectures (3 fois au plus).',
  ),
  protectiveNotSent: (reason) =>
    both(
      `Not sent now (${reason.en}): sent again with the next reads (3 times at most).`,
      `Pas envoyé pour l’instant (${reason.fr}) : renvoyé avec les prochaines lectures (3 fois au plus).`,
    ),
};
