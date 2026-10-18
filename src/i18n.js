// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the
// e-mail address, the password, a tracker name or a position.
// -----------------------------------------------------------------------------

import { CODES } from './invoxia/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
/** French: 0 and 1 take the singular ("0 traceur muet"). */
const pluralFr = (n, one, many) => (n <= 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** A delay in words: minutes below 1 h, hours above. */
const delayText = (ms) => {
  const m = minutes(ms);
  if (m < 60) return { en: `${m} min`, fr: `${m} min` };
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const t = rest ? `${h} h ${rest} min` : `${h} h`;
  return { en: t, fr: t };
};

/** A silence delay of the configuration in words. */
const silentText = (m) =>
  m % 60 === 0 ? { en: `${m / 60} h`, fr: `${m / 60} h` } : { en: `${m} min`, fr: `${m} min` };

/** Why Invoxia failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.TLS_UNTRUSTED:
      return { en: 'certificate not trusted', fr: 'certificat non reconnu' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => {
  const d = delayText(delay);
  return { en: `Retried in ${d.en}.`, fr: `Nouvel essai dans ${d.fr}.` };
};

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ total, silent, silentMinutes, capped }) => {
      const s = silentText(silentMinutes);
      return join(
        {
          en: `Invoxia answers: ${total} ${plural(total, 'tracker', 'trackers')}, ${silent} silent for more than ${s.en}.`,
          fr: `Invoxia répond : ${total} ${pluralFr(total, 'traceur', 'traceurs')}, ${silent} ${pluralFr(silent, 'muet', 'muets')} depuis plus de ${s.fr}.`,
        },
        capped > 0
          ? {
              en: `${capped} more ${plural(capped, 'tracker is', 'trackers are')} left out (20 at most).`,
              fr: `${capped} ${pluralFr(capped, 'autre traceur est ignoré', 'autres traceurs sont ignorés')} (20 au plus).`,
            }
          : {},
      );
    },
    noDevice: {
      en: 'Invoxia answers, but the account has no tracker.',
      fr: 'Invoxia répond, mais le compte n’a aucun traceur.',
    },
    missingCredentials: {
      en: 'Type the e-mail address and the password of your Invoxia account (the ones of the Invoxia app).',
      fr: 'Saisissez l’adresse e-mail et le mot de passe de votre compte Invoxia (ceux de l’application Invoxia).',
    },
    usernameInvalid: {
      en: 'The e-mail address cannot hold ":" nor a line break: type it again. Nothing was sent.',
      fr: 'L’adresse e-mail ne peut contenir ni « : » ni retour à la ligne : saisissez-la de nouveau. Rien n’a été envoyé.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or a control character (pasted?): type it again. Nothing was sent.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle (collé ?) : saisissez-le de nouveau. Rien n’a été envoyé.',
    },
    configUnreadable: {
      en: 'Gladys did not give the configuration of the integration: read again in 1 min.',
      fr: 'Gladys n’a pas transmis la configuration de l’intégration : nouvelle lecture dans 1 min.',
    },
    refused: (status, delay) =>
      join({
        en: `Invoxia refused the e-mail address or the password (HTTP ${status}). A wrong password tried again and again may lock the account: Gladys stops for ${delayText(delay).en} (1 h, then 6 h, then 24 h). Saving the configuration tries once per series of refusals (other credentials: at once).`,
        fr: `Invoxia a refusé l’adresse e-mail ou le mot de passe (HTTP ${status}). Un mauvais mot de passe essayé encore et encore peut bloquer le compte : Gladys s’arrête ${delayText(delay).fr} (1 h, puis 6 h, puis 24 h). Enregistrer la configuration fait un essai par série de refus (d’autres identifiants : tout de suite).`,
      }),
    stillRefused: (delay, forced = false) =>
      forced
        ? {
            en: `Invoxia refused these credentials earlier, and they were already tried again: next attempt in ${delayText(delay).en} (other credentials are tried at once).`,
            fr: `Invoxia a refusé ces identifiants plus tôt, et ils ont déjà été réessayés : prochain essai dans ${delayText(delay).fr} (d’autres identifiants sont essayés tout de suite).`,
          }
        : {
            en: `Invoxia refused these credentials earlier: Gladys waits ${delayText(delay).en} before trying again (saving the configuration tries once at once).`,
            fr: `Invoxia a refusé ces identifiants plus tôt : Gladys attend ${delayText(delay).fr} avant de réessayer (enregistrer la configuration fait un essai tout de suite).`,
          },
    alreadyRetried: (delay) => ({
      en: `Already tried again after this refusal: next attempt in ${delayText(delay).en}. Saving the same credentials again does not shorten the stop (other credentials are tried at once).`,
      fr: `Déjà réessayé après ce refus : prochain essai dans ${delayText(delay).fr}. Enregistrer de nouveau les mêmes identifiants ne raccourcit pas l’arrêt (d’autres identifiants sont essayés tout de suite).`,
    }),
    internal: (delay) =>
      join(
        {
          en: 'Internal error of the integration while reading the answer of Invoxia (see the logs of the integration).',
          fr: 'Erreur interne de l’intégration en lisant la réponse d’Invoxia (voir les journaux de l’intégration).',
        },
        RETRY(delay),
      ),
    tooLarge: (delay) =>
      join(
        {
          en: 'Invoxia answers, but the answer is too large (above 1 MB).',
          fr: 'Invoxia répond, mais la réponse est trop grande (plus de 1 Mo).',
        },
        RETRY(delay),
      ),
    tlsUntrusted: (delay) =>
      join(
        {
          en: 'The certificate of the Invoxia API is not trusted: nothing was sent (a proxy or a firewall in between?).',
          fr: 'Le certificat de l’API Invoxia n’est pas reconnu : rien n’a été envoyé (un proxy ou un pare-feu entre les deux ?).',
        },
        RETRY(delay),
      ),
    forbidden: (delay) =>
      join(
        {
          en: 'Access refused (HTTP 403) by something else than the Invoxia API (a firewall, a proxy?): not about the credentials.',
          fr: 'Accès refusé (HTTP 403) par autre chose que l’API Invoxia (un pare-feu, un proxy ?) : rien à voir avec les identifiants.',
        },
        RETRY(delay),
      ),
    badAnswer: (delay) =>
      join(
        {
          en: 'The Invoxia API answers in an unexpected way (it may have changed).',
          fr: 'L’API Invoxia répond de façon inattendue (elle a peut-être changé).',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'Invoxia asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Invoxia demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `Invoxia answers with a server error (HTTP ${status}, maintenance?): every request is paused.`,
          fr: `Invoxia répond par une erreur serveur (HTTP ${status}, maintenance ?) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    paused: (delay) =>
      join(
        {
          en: 'Invoxia asked Gladys to wait (HTTP 429 or a server error): the pause goes on.',
          fr: 'Invoxia a demandé à Gladys d’attendre (HTTP 429 ou erreur serveur) : la pause continue.',
        },
        RETRY(delay),
      ),
    retryPending: (delay) =>
      join(
        {
          en: 'The last reading of Invoxia failed (before the restart of the integration).',
          fr: 'La dernière lecture d’Invoxia a échoué (avant le redémarrage de l’intégration).',
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'Invoxia does not answer:', fr: 'Invoxia ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ total, silent }) => ({
      en: `Connected: ${total} ${plural(total, 'tracker', 'trackers')}, ${silent} silent. Add them from the Discovery tab.`,
      fr: `Connecté : ${total} ${pluralFr(total, 'traceur', 'traceurs')}, ${silent} ${pluralFr(silent, 'muet', 'muets')}. Ajoutez-les depuis l’onglet Découverte.`,
    }),
  },
  errors: {
    readOnly: 'This integration only reads Invoxia: nothing can be changed from Gladys',
    notConnected: 'Invoxia is not connected: see the configuration of the integration',
    testTooLong:
      'Invoxia has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
