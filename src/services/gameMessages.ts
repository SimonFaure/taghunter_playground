// Shared in-game message vocabulary for the playground.
//
// All game types (Mystery, TagQuest, Tracks) render transient status messages
// through <GameMessageOverlay>, which is typed by GameMessageType. The localized
// status strings below are shared so the same wording/translations are used
// everywhere (lifted from TagQuest's old inline STATUS_MESSAGES + extended with
// Tracks-specific keys). Languages mirror the HUD-label set (fr/en/es/de/it/pt)
// and fall back to fr, then to a raw server message where one is available.

export type GameMessageType = 'success' | 'error' | 'warning' | 'info';

export type StatusKey =
  | 'chip_not_recognized'
  | 'team_already_finished'
  | 'cheat_detected'
  | 'error'
  | 'card_not_registered'
  | 'track_finished'
  | 'no_checkpoints'
  | 'reuse_cooldown';

const STATUS_MESSAGES: Record<string, Record<StatusKey, string>> = {
  fr: {
    chip_not_recognized: 'Carte non reconnue',
    team_already_finished: 'Équipe déjà terminée',
    cheat_detected: 'Triche détectée',
    error: 'Erreur',
    card_not_registered: 'Carte non enregistrée',
    track_finished: 'Parcours terminé !',
    no_checkpoints: 'Aucun point validé',
    reuse_cooldown: 'Carte rejouable dans {n} min',
  },
  en: {
    chip_not_recognized: 'Card not recognized',
    team_already_finished: 'Team already finished',
    cheat_detected: 'Cheating detected',
    error: 'Error',
    card_not_registered: 'Card not registered',
    track_finished: 'Route complete!',
    no_checkpoints: 'No checkpoints found',
    reuse_cooldown: 'Card playable again in {n} min',
  },
  es: {
    chip_not_recognized: 'Tarjeta no reconocida',
    team_already_finished: 'Equipo ya terminado',
    cheat_detected: 'Trampa detectada',
    error: 'Error',
    card_not_registered: 'Tarjeta no registrada',
    track_finished: '¡Recorrido completado!',
    no_checkpoints: 'Ningún punto validado',
    reuse_cooldown: 'Tarjeta disponible en {n} min',
  },
  de: {
    chip_not_recognized: 'Karte nicht erkannt',
    team_already_finished: 'Team bereits fertig',
    cheat_detected: 'Betrug erkannt',
    error: 'Fehler',
    card_not_registered: 'Karte nicht registriert',
    track_finished: 'Strecke abgeschlossen!',
    no_checkpoints: 'Keine Posten gefunden',
    reuse_cooldown: 'Karte in {n} Min wieder spielbar',
  },
  it: {
    chip_not_recognized: 'Tessera non riconosciuta',
    team_already_finished: 'Squadra già terminata',
    cheat_detected: 'Imbroglio rilevato',
    error: 'Errore',
    card_not_registered: 'Tessera non registrata',
    track_finished: 'Percorso completato!',
    no_checkpoints: 'Nessun punto trovato',
    reuse_cooldown: 'Tessera riutilizzabile tra {n} min',
  },
  pt: {
    chip_not_recognized: 'Cartão não reconhecido',
    team_already_finished: 'Equipa já terminou',
    cheat_detected: 'Batota detetada',
    error: 'Erro',
    card_not_registered: 'Cartão não registado',
    track_finished: 'Percurso concluído!',
    no_checkpoints: 'Nenhum ponto validado',
    reuse_cooldown: 'Cartão jogável em {n} min',
  },
};

/** Localized text for a known status key, fr fallback. */
export function localizedStatus(key: StatusKey, lang: string): string {
  const table = STATUS_MESSAGES[lang] ?? STATUS_MESSAGES.fr;
  return table[key] ?? STATUS_MESSAGES.fr[key];
}

// TagQuest punch-status → message type. Kept here so the status vocabulary and
// its severities live in one place.
const STATUS_TYPE: Partial<Record<StatusKey, GameMessageType>> = {
  chip_not_recognized: 'warning',
  team_already_finished: 'info',
  cheat_detected: 'error',
  error: 'error',
};

/** Build the user-facing message + type for a non-ok punch result. */
export function describePunchStatus(
  status: string,
  teamName: string,
  fallbackMsg: string | undefined,
  lang: string,
): { text: string; type: GameMessageType } {
  const key = status as StatusKey;
  const table = STATUS_MESSAGES[lang] ?? STATUS_MESSAGES.fr;
  const base = table[key] ?? STATUS_MESSAGES.fr[key] ?? fallbackMsg ?? STATUS_MESSAGES.fr.error;
  const type = STATUS_TYPE[key] ?? 'warning';
  return { text: teamName ? `${teamName} — ${base}` : base, type };
}
