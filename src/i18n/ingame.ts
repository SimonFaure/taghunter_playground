/**
 * In-game shared text (bucket 2) on the i18next engine.
 *
 * These are the game-type-agnostic + per-type strings shown to players during a
 * game (punch-status messages, tagquest HUD labels, …). Unlike chrome, they
 * resolve against the *team* language, and they are admin-editable + synced from
 * studio so wording can change without a Tauri release.
 *
 * Two layers, both on the same i18next instance as chrome:
 *  1. BASELINES - bundled in the build (lifted from the former `gameMessages.ts`
 *     STATUS_MESSAGES + `defaultPreviewLabels.ts`). Guarantee text offline / on a
 *     fresh device before any sync. Registered with overwrite:false.
 *  2. SYNCED OVERLAY - `hydrateIngameFromStore()` reads the synced
 *     `admin_translations` blobs and overlays them with overwrite:true.
 *
 * Namespaces: `ingame_common`, `ingame_tagquest`, `ingame_mystery`,
 * `ingame_tracks`, `ingame_clash`. Interpolation is i18next-standard `{{var}}`.
 *
 * Design: plan `multilingual-app-translator-workflow.md` (step 2).
 */

import i18n from 'i18next';
import * as translationsStore from '../services/translationsStore';
import { PIVOT_LANG } from './languages';

export const INGAME_NAMESPACES = [
  'ingame_common',
  'ingame_tagquest',
  'ingame_mystery',
  'ingame_tracks',
  'ingame_clash',
] as const;
export type IngameNamespace = (typeof INGAME_NAMESPACES)[number];

/** Manifest/store meta keys mirror the namespace names 1:1. */
export const INGAME_STORE_KEYS = INGAME_NAMESPACES;

type Catalog = Record<string, Record<string, string>>; // lang -> key -> value

/**
 * ingame_common - punch/status vocabulary shared by all game types. Lifted from
 * the former gameMessages STATUS_MESSAGES; `{n}` placeholders kept as `{{n}}`.
 */
const COMMON_BASELINE: Catalog = {
  fr: {
    chip_not_recognized: 'Puce non reconnue',
    card_empty: 'Puce vide',
    team_already_finished: 'Équipe déjà terminée',
    cheat_detected: 'Triche détectée',
    error: 'Erreur',
    card_not_registered: 'Puce non enregistrée',
    track_finished: 'Parcours terminé !',
    no_checkpoints: 'Aucun point validé',
    reuse_cooldown: 'Puce rejouable dans {{n}} min',
    punches_already_counted: 'Poinçons déjà comptés - bipez de nouvelles balises',
    punches_not_wiped: 'Puce non vidée - les poinçons présents avant le départ ne comptent pas',
    card_full: 'Puce pleine - videz-la, les nouveaux poinçons ne sont plus enregistrés',
    pending_teams_prefix: 'En attente :',
    no_station_match: "Aucun poste bipé ne correspond au modèle du scénario",
    pattern_missing: 'Modèle de postes introuvable ou vide',
    no_quests: 'Aucune quête dans les données du scénario',
  },
  en: {
    chip_not_recognized: 'Card not recognized',
    card_empty: 'Card empty',
    team_already_finished: 'Team already finished',
    cheat_detected: 'Cheating detected',
    error: 'Error',
    card_not_registered: 'Card not registered',
    track_finished: 'Route complete!',
    no_checkpoints: 'No checkpoints found',
    reuse_cooldown: 'Card playable again in {{n}} min',
    punches_already_counted: 'Punches already counted - go punch new stations',
    punches_not_wiped: 'Card not wiped - punches already on it before the start do not count',
    card_full: 'Card full - wipe it, new punches are no longer recorded',
    pending_teams_prefix: 'Waiting:',
    no_station_match: "None of the punched stations match this scenario's pattern",
    pattern_missing: 'Station pattern missing or empty',
    no_quests: 'No quest in the scenario data',
  },
  es: {
    chip_not_recognized: 'Tarjeta no reconocida',
    card_empty: 'Tarjeta vacía',
    team_already_finished: 'Equipo ya terminado',
    cheat_detected: 'Trampa detectada',
    error: 'Error',
    card_not_registered: 'Tarjeta no registrada',
    track_finished: '¡Recorrido completado!',
    no_checkpoints: 'Ningún punto validado',
    reuse_cooldown: 'Tarjeta disponible en {{n}} min',
    punches_already_counted: 'Marcajes ya contados - marque nuevas estaciones',
    punches_not_wiped: 'Tarjeta sin borrar - los marcajes previos a la salida no cuentan',
    card_full: 'Tarjeta llena - bórrela, los nuevos marcajes ya no se registran',
    pending_teams_prefix: 'En espera:',
    no_station_match: 'Ninguna estación marcada coincide con el modelo del escenario',
    pattern_missing: 'Modelo de estaciones ausente o vacío',
    no_quests: 'No hay ninguna misión en los datos del escenario',
  },
  de: {
    chip_not_recognized: 'Karte nicht erkannt',
    card_empty: 'Karte leer',
    team_already_finished: 'Team bereits fertig',
    cheat_detected: 'Betrug erkannt',
    error: 'Fehler',
    card_not_registered: 'Karte nicht registriert',
    track_finished: 'Strecke abgeschlossen!',
    no_checkpoints: 'Keine Posten gefunden',
    reuse_cooldown: 'Karte in {{n}} Min wieder spielbar',
    punches_already_counted: 'Stempel bereits gezählt - neue Posten stempeln',
    punches_not_wiped: 'Karte nicht gelöscht - Stempel von vor dem Start zählen nicht',
    card_full: 'Karte voll - bitte löschen, neue Stempel werden nicht mehr gespeichert',
    pending_teams_prefix: 'Wartend:',
    no_station_match: 'Kein gestempelter Posten passt zum Muster des Szenarios',
    pattern_missing: 'Postenmuster fehlt oder ist leer',
    no_quests: 'Keine Quest in den Szenariodaten',
  },
  it: {
    chip_not_recognized: 'Tessera non riconosciuta',
    card_empty: 'Tessera vuota',
    team_already_finished: 'Squadra già terminata',
    cheat_detected: 'Imbroglio rilevato',
    error: 'Errore',
    card_not_registered: 'Tessera non registrata',
    track_finished: 'Percorso completato!',
    no_checkpoints: 'Nessun punto trovato',
    reuse_cooldown: 'Tessera riutilizzabile tra {{n}} min',
    punches_already_counted: 'Punzonature già conteggiate - punzona nuove stazioni',
    punches_not_wiped: 'Tessera non azzerata - le punzonature precedenti alla partenza non contano',
    card_full: 'Tessera piena - azzerala, le nuove punzonature non vengono più registrate',
    pending_teams_prefix: 'In attesa:',
    no_station_match: 'Nessuna stazione punzonata corrisponde al modello dello scenario',
    pattern_missing: 'Modello delle stazioni mancante o vuoto',
    no_quests: 'Nessuna missione nei dati dello scenario',
  },
  pt: {
    chip_not_recognized: 'Cartão não reconhecido',
    card_empty: 'Cartão vazio',
    team_already_finished: 'Equipa já terminou',
    cheat_detected: 'Batota detetada',
    error: 'Erro',
    card_not_registered: 'Cartão não registado',
    track_finished: 'Percurso concluído!',
    no_checkpoints: 'Nenhum ponto validado',
    reuse_cooldown: 'Cartão jogável em {{n}} min',
    punches_already_counted: 'Registos já contados - pique novos postos',
    punches_not_wiped: 'Cartão não apagado - os registos anteriores à partida não contam',
    card_full: 'Cartão cheio - apague-o, os novos registos já não são guardados',
    pending_teams_prefix: 'Em espera:',
    no_station_match: 'Nenhum posto picado corresponde ao modelo do cenário',
    pattern_missing: 'Modelo de postos em falta ou vazio',
    no_quests: 'Nenhuma missão nos dados do cenário',
  },
};

/**
 * ingame_tagquest - the four global tagquest HUD labels (lifted from
 * defaultPreviewLabels DEFAULTS; `{s}` placeholder kept as `{{s}}`; MIRROR of
 * studio's previewLabels defaults - keep both in sync) PLUS the `reg_*` keys of
 * the self-register inscription screen.
 *
 * `reg_*` is the Quest twin of the Clash registration block below: the screen
 * players stand in front of before the match, so it resolves against the LAUNCH
 * language like every other bucket-2 string. Retours Ludiom #72 - the whole
 * screen used to be hardcoded English.
 */
const TAGQUEST_BASELINE: Catalog = {
  fr: {
    score: 'SCORE', malus: 'MALUS', late_malus: 'MALUS RETARD', combo_points: 'POINTS COMBO',
    next_malus: 'Prochain malus dans {{s}} s',
    reg_title_team: 'Inscription des équipes',
    reg_title_solo: 'Inscription des joueurs',
    reg_back: 'Retour',
    reg_intro_locked_one: 'Cette station inscrit une seule équipe - les joueurs bipent leur puce ici pour la rejoindre.',
    reg_intro_locked_many: 'Cette station inscrit uniquement les équipes ci-dessous - choisissez-en une, puis les joueurs bipent leur puce pour la rejoindre.',
    reg_intro_team: "Sélectionnez une équipe sur cette station, puis les joueurs bipent leur puce pour la rejoindre. Laissez une station sur une équipe pour en faire un lecteur d'inscription dédié.",
    reg_intro_solo: 'Chaque joueur bipe sa puce pour s’inscrire - une équipe est créée par puce. Démarrez la partie une fois tout le monde inscrit.',
    reg_no_assigned_team: "Aucune équipe ne correspond à l'affectation de cette station - demandez à l'opérateur de la mettre à jour depuis le panneau Appareils.",
    reg_full: 'Complet',
    reg_team_fallback: 'Équipe {{n}}',
    reg_player_fallback: 'Joueur {{n}}',
    reg_station_complete: 'Inscription terminée sur cette station',
    reg_station_complete_one: "L'équipe affectée est complète.",
    reg_station_complete_many: 'Toutes les équipes affectées sont complètes.',
    reg_bip_to_join: 'Bipez une puce pour rejoindre {{team}}',
    reg_select_team_hint: 'Sélectionnez une équipe ci-dessus pour commencer les inscriptions.',
    reg_players_enrolled_one: '{{count}} joueur inscrit',
    reg_players_enrolled_other: '{{count}} joueurs inscrits',
    reg_waiting_first_bip: 'En attente du premier bip…',
    reg_start_game: 'Démarrer la partie',
    reg_join_ok: '{{team}} rejointe ✓',
    reg_join_ok_generic: 'Équipe rejointe ✓',
    reg_join_ok_solo: '{{team}} inscrit ✓',
    reg_join_ok_solo_generic: 'Joueur inscrit ✓',
    reg_join_team_full: 'Équipe complète - passage à la suivante, bipez de nouveau',
    reg_join_already_in_team: 'Déjà dans {{team}}',
    reg_join_already_enrolled: 'Déjà inscrit',
    reg_join_already_other_team: 'Cette puce appartient déjà à une autre équipe',
    msg_game_finished: "{{team}} - Partie terminée !",
    finish_title: "Arrivée !",
    finish_well_done: "Bravo {{team}} !",
    finish_time: "Temps",
    msg_quest_complete: "{{team}} - {{quest}} terminée ! +{{points}} pts",
    msg_quest_complete_malus: "{{team}} - {{quest}} terminée ! +{{points}} pts (−{{malus}} malus de retard)",
    msg_level_up: "{{team}} - Niveau supérieur : {{level}} !",
    msg_level_up_short: "Niveau supérieur : {{level}} !",
    msg_partial_quest_one: "{{team}} - {{quest}} : {{count}} image trouvée",
    msg_partial_quest_other: "{{team}} - {{quest}} : {{count}} images trouvées",
    reg_join_team_not_found: 'Équipe introuvable',
  },
  en: {
    score: 'SCORE', malus: 'PENALTY', late_malus: 'LATE PENALTY', combo_points: 'COMBO POINTS',
    next_malus: 'Next malus in {{s}} s',
    reg_title_team: 'Team registration',
    reg_title_solo: 'Player registration',
    reg_back: 'Back',
    reg_intro_locked_one: 'This station registers one team only - players bip their chip here to join it.',
    reg_intro_locked_many: 'This station registers the teams below only - pick one, then players bip their chip to join it.',
    reg_intro_team: 'Select a team on this station, then players bip their chip to join it. Leave a station on one team to use it as a dedicated join reader.',
    reg_intro_solo: 'Each player bips their chip to enrol - a team is created per chip. Start the game once everyone has joined.',
    reg_no_assigned_team: "No team matches this station's assignment - ask the operator to update it from the Devices panel.",
    reg_full: 'Full',
    reg_team_fallback: 'Team {{n}}',
    reg_player_fallback: 'Player {{n}}',
    reg_station_complete: 'Registration complete on this station',
    reg_station_complete_one: 'The assigned team is full.',
    reg_station_complete_many: 'All assigned teams are full.',
    reg_bip_to_join: 'Bip a chip to join {{team}}',
    reg_select_team_hint: 'Select a team above to start enrolling players.',
    reg_players_enrolled_one: '{{count}} player enrolled',
    reg_players_enrolled_other: '{{count}} players enrolled',
    reg_waiting_first_bip: 'Waiting for the first bip…',
    reg_start_game: 'Start game',
    reg_join_ok: 'Joined {{team}} ✓',
    reg_join_ok_generic: 'Joined ✓',
    reg_join_ok_solo: '{{team}} enrolled ✓',
    reg_join_ok_solo_generic: 'Player enrolled ✓',
    reg_join_team_full: 'Team full - moved to the next team, bip again',
    reg_join_already_in_team: 'Already in {{team}}',
    reg_join_already_enrolled: 'Already enrolled',
    reg_join_already_other_team: 'Chip already belongs to another team',
    msg_game_finished: "{{team}} - Game finished!",
    finish_title: "Finish!",
    finish_well_done: "Well done {{team}}!",
    finish_time: "Time",
    msg_quest_complete: "{{team}} - {{quest}} complete! +{{points}} pts",
    msg_quest_complete_malus: "{{team}} - {{quest}} complete! +{{points}} pts (−{{malus}} late malus)",
    msg_level_up: "{{team}} - Level up: {{level}}!",
    msg_level_up_short: "Level up: {{level}}!",
    msg_partial_quest_one: "{{team}} - {{quest}}: {{count}} image found",
    msg_partial_quest_other: "{{team}} - {{quest}}: {{count}} images found",
    reg_join_team_not_found: 'Team not found',
  },
  es: {
    score: 'PUNTUACIÓN', malus: 'PENALIZACIÓN', late_malus: 'PENALIZACIÓN TARDÍA', combo_points: 'PUNTOS COMBO',
    next_malus: 'Próxima penalización en {{s}} s',
    reg_title_team: 'Inscripción de equipos',
    reg_title_solo: 'Inscripción de jugadores',
    reg_back: 'Volver',
    reg_intro_locked_one: 'Esta estación inscribe un solo equipo: los jugadores pasan su tarjeta aquí para unirse.',
    reg_intro_locked_many: 'Esta estación inscribe únicamente los equipos de abajo: elige uno y los jugadores pasan su tarjeta para unirse.',
    reg_intro_team: 'Selecciona un equipo en esta estación y los jugadores pasarán su tarjeta para unirse. Deja una estación fija en un equipo para usarla como lector de inscripción.',
    reg_intro_solo: 'Cada jugador pasa su tarjeta para inscribirse: se crea un equipo por tarjeta. Empieza la partida cuando estén todos.',
    reg_no_assigned_team: 'Ningún equipo coincide con la asignación de esta estación: pide al operador que la actualice desde el panel Dispositivos.',
    reg_full: 'Completo',
    reg_team_fallback: 'Equipo {{n}}',
    reg_player_fallback: 'Jugador {{n}}',
    reg_station_complete: 'Inscripción completada en esta estación',
    reg_station_complete_one: 'El equipo asignado está completo.',
    reg_station_complete_many: 'Todos los equipos asignados están completos.',
    reg_bip_to_join: 'Pasa una tarjeta para unirte a {{team}}',
    reg_select_team_hint: 'Selecciona un equipo arriba para empezar a inscribir jugadores.',
    reg_players_enrolled_one: '{{count}} jugador inscrito',
    reg_players_enrolled_other: '{{count}} jugadores inscritos',
    reg_waiting_first_bip: 'Esperando el primer fichaje…',
    reg_start_game: 'Empezar partida',
    reg_join_ok: '{{team}}: unido ✓',
    reg_join_ok_generic: 'Unido ✓',
    reg_join_ok_solo: '{{team}} inscrito ✓',
    reg_join_ok_solo_generic: 'Jugador inscrito ✓',
    reg_join_team_full: 'Equipo completo: se pasa al siguiente, vuelve a fichar',
    reg_join_already_in_team: 'Ya está en {{team}}',
    reg_join_already_enrolled: 'Ya inscrito',
    reg_join_already_other_team: 'La tarjeta ya pertenece a otro equipo',
    msg_game_finished: "{{team}} - ¡Partida terminada!",
    finish_title: "¡Llegada!",
    finish_well_done: "¡Bravo {{team}}!",
    finish_time: "Tiempo",
    msg_quest_complete: "{{team}} - ¡{{quest}} completada! +{{points}} pts",
    msg_quest_complete_malus: "{{team}} - ¡{{quest}} completada! +{{points}} pts (−{{malus}} de penalización por retraso)",
    msg_level_up: "{{team}} - ¡Sube de nivel: {{level}}!",
    msg_level_up_short: "¡Sube de nivel: {{level}}!",
    msg_partial_quest_one: "{{team}} - {{quest}}: {{count}} imagen encontrada",
    msg_partial_quest_other: "{{team}} - {{quest}}: {{count}} imágenes encontradas",
    reg_join_team_not_found: 'Equipo no encontrado',
  },
  de: {
    score: 'PUNKTE', malus: 'STRAFE', late_malus: 'VERSPÄTUNGSSTRAFE', combo_points: 'KOMBO-PUNKTE',
    next_malus: 'Nächste Strafe in {{s}} s',
    reg_title_team: 'Team-Anmeldung',
    reg_title_solo: 'Spieleranmeldung',
    reg_back: 'Zurück',
    reg_intro_locked_one: 'Diese Station meldet nur ein Team an - die Spieler stempeln ihre Karte hier, um beizutreten.',
    reg_intro_locked_many: 'Diese Station meldet nur die Teams unten an - eines auswählen, dann stempeln die Spieler ihre Karte zum Beitritt.',
    reg_intro_team: 'Wählen Sie an dieser Station ein Team; die Spieler stempeln dann ihre Karte, um beizutreten. Bleibt eine Station auf einem Team, wird sie zum festen Anmeldeleser.',
    reg_intro_solo: 'Jeder Spieler stempelt seine Karte zur Anmeldung - pro Karte entsteht ein Team. Starten Sie das Spiel, sobald alle dabei sind.',
    reg_no_assigned_team: 'Kein Team passt zur Zuweisung dieser Station - bitten Sie den Betreiber, sie im Geräte-Panel zu aktualisieren.',
    reg_full: 'Voll',
    reg_team_fallback: 'Team {{n}}',
    reg_player_fallback: 'Spieler {{n}}',
    reg_station_complete: 'Anmeldung an dieser Station abgeschlossen',
    reg_station_complete_one: 'Das zugewiesene Team ist voll.',
    reg_station_complete_many: 'Alle zugewiesenen Teams sind voll.',
    reg_bip_to_join: 'Karte stempeln, um {{team}} beizutreten',
    reg_select_team_hint: 'Wählen Sie oben ein Team, um mit der Anmeldung zu beginnen.',
    reg_players_enrolled_one: '{{count}} Spieler angemeldet',
    reg_players_enrolled_other: '{{count}} Spieler angemeldet',
    reg_waiting_first_bip: 'Warte auf den ersten Stempel…',
    reg_start_game: 'Spiel starten',
    reg_join_ok: '{{team}} beigetreten ✓',
    reg_join_ok_generic: 'Beigetreten ✓',
    reg_join_ok_solo: '{{team}} angemeldet ✓',
    reg_join_ok_solo_generic: 'Spieler angemeldet ✓',
    reg_join_team_full: 'Team voll - weiter zum nächsten, erneut stempeln',
    reg_join_already_in_team: 'Bereits in {{team}}',
    reg_join_already_enrolled: 'Bereits angemeldet',
    reg_join_already_other_team: 'Die Karte gehört bereits zu einem anderen Team',
    msg_game_finished: "{{team}} - Spiel beendet!",
    finish_title: "Ziel erreicht!",
    finish_well_done: "Bravo {{team}}!",
    finish_time: "Zeit",
    msg_quest_complete: "{{team}} - {{quest}} abgeschlossen! +{{points}} Pkt",
    msg_quest_complete_malus: "{{team}} - {{quest}} abgeschlossen! +{{points}} Pkt (−{{malus}} Verspätungsmalus)",
    msg_level_up: "{{team}} - Levelaufstieg: {{level}}!",
    msg_level_up_short: "Levelaufstieg: {{level}}!",
    msg_partial_quest_one: "{{team}} - {{quest}}: {{count}} Bild gefunden",
    msg_partial_quest_other: "{{team}} - {{quest}}: {{count}} Bilder gefunden",
    reg_join_team_not_found: 'Team nicht gefunden',
  },
  it: {
    score: 'PUNTEGGIO', malus: 'PENALITÀ', late_malus: 'PENALITÀ IN RITARDO', combo_points: 'PUNTI COMBO',
    next_malus: 'Prossima penalità tra {{s}} s',
    reg_title_team: 'Iscrizione delle squadre',
    reg_title_solo: 'Iscrizione dei giocatori',
    reg_back: 'Indietro',
    reg_intro_locked_one: 'Questa stazione iscrive una sola squadra - i giocatori punzonano qui la loro tessera per unirsi.',
    reg_intro_locked_many: 'Questa stazione iscrive solo le squadre qui sotto - scegline una, poi i giocatori punzonano la tessera per unirsi.',
    reg_intro_team: 'Seleziona una squadra su questa stazione, poi i giocatori punzonano la tessera per unirsi. Lascia una stazione su una squadra per usarla come lettore di iscrizione dedicato.',
    reg_intro_solo: 'Ogni giocatore punzona la propria tessera per iscriversi - viene creata una squadra per tessera. Avvia la partita quando sono tutti iscritti.',
    reg_no_assigned_team: "Nessuna squadra corrisponde all'assegnazione di questa stazione - chiedi all'operatore di aggiornarla dal pannello Dispositivi.",
    reg_full: 'Al completo',
    reg_team_fallback: 'Squadra {{n}}',
    reg_player_fallback: 'Giocatore {{n}}',
    reg_station_complete: 'Iscrizione completata su questa stazione',
    reg_station_complete_one: 'La squadra assegnata è al completo.',
    reg_station_complete_many: 'Tutte le squadre assegnate sono al completo.',
    reg_bip_to_join: 'Punzona una tessera per unirti a {{team}}',
    reg_select_team_hint: 'Seleziona una squadra qui sopra per iniziare le iscrizioni.',
    reg_players_enrolled_one: '{{count}} giocatore iscritto',
    reg_players_enrolled_other: '{{count}} giocatori iscritti',
    reg_waiting_first_bip: 'In attesa della prima punzonatura…',
    reg_start_game: 'Avvia la partita',
    reg_join_ok: '{{team}} raggiunta ✓',
    reg_join_ok_generic: 'Squadra raggiunta ✓',
    reg_join_ok_solo: '{{team}} iscritto ✓',
    reg_join_ok_solo_generic: 'Giocatore iscritto ✓',
    reg_join_team_full: 'Squadra al completo - si passa alla successiva, punzona di nuovo',
    reg_join_already_in_team: 'Già in {{team}}',
    reg_join_already_enrolled: 'Già iscritto',
    reg_join_already_other_team: 'Questa tessera appartiene già a un’altra squadra',
    msg_game_finished: "{{team}} - Partita terminata!",
    finish_title: "Arrivo!",
    finish_well_done: "Bravo {{team}}!",
    finish_time: "Tempo",
    msg_quest_complete: "{{team}} - {{quest}} completata! +{{points}} pt",
    msg_quest_complete_malus: "{{team}} - {{quest}} completata! +{{points}} pt (−{{malus}} malus di ritardo)",
    msg_level_up: "{{team}} - Salita di livello: {{level}}!",
    msg_level_up_short: "Salita di livello: {{level}}!",
    msg_partial_quest_one: "{{team}} - {{quest}}: {{count}} immagine trovata",
    msg_partial_quest_other: "{{team}} - {{quest}}: {{count}} immagini trovate",
    reg_join_team_not_found: 'Squadra non trovata',
  },
  pt: {
    score: 'PONTUAÇÃO', malus: 'PENALIDADE', late_malus: 'PENALIDADE TARDIA', combo_points: 'PONTOS COMBO',
    next_malus: 'Próxima penalidade em {{s}} s',
    reg_title_team: 'Inscrição das equipas',
    reg_title_solo: 'Inscrição dos jogadores',
    reg_back: 'Voltar',
    reg_intro_locked_one: 'Esta estação inscreve apenas uma equipa - os jogadores picam aqui o seu cartão para entrar.',
    reg_intro_locked_many: 'Esta estação inscreve apenas as equipas abaixo - escolha uma e os jogadores picam o cartão para entrar.',
    reg_intro_team: 'Selecione uma equipa nesta estação e os jogadores picam o cartão para entrar. Deixe uma estação fixa numa equipa para a usar como leitor de inscrição.',
    reg_intro_solo: 'Cada jogador pica o seu cartão para se inscrever - é criada uma equipa por cartão. Inicie o jogo quando estiverem todos.',
    reg_no_assigned_team: 'Nenhuma equipa corresponde à atribuição desta estação - peça ao operador para a atualizar no painel Dispositivos.',
    reg_full: 'Completa',
    reg_team_fallback: 'Equipa {{n}}',
    reg_player_fallback: 'Jogador {{n}}',
    reg_station_complete: 'Inscrição concluída nesta estação',
    reg_station_complete_one: 'A equipa atribuída está completa.',
    reg_station_complete_many: 'Todas as equipas atribuídas estão completas.',
    reg_bip_to_join: 'Pique um cartão para entrar em {{team}}',
    reg_select_team_hint: 'Selecione uma equipa acima para começar as inscrições.',
    reg_players_enrolled_one: '{{count}} jogador inscrito',
    reg_players_enrolled_other: '{{count}} jogadores inscritos',
    reg_waiting_first_bip: 'À espera da primeira picagem…',
    reg_start_game: 'Iniciar o jogo',
    reg_join_ok: '{{team}} - entrou ✓',
    reg_join_ok_generic: 'Entrou ✓',
    reg_join_ok_solo: '{{team}} inscrito ✓',
    reg_join_ok_solo_generic: 'Jogador inscrito ✓',
    reg_join_team_full: 'Equipa completa - passou para a seguinte, pique de novo',
    reg_join_already_in_team: 'Já está em {{team}}',
    reg_join_already_enrolled: 'Já inscrito',
    reg_join_already_other_team: 'Este cartão já pertence a outra equipa',
    msg_game_finished: "{{team}} - Jogo terminado!",
    finish_title: "Chegada!",
    finish_well_done: "Parabéns {{team}}!",
    finish_time: "Tempo",
    msg_quest_complete: "{{team}} - {{quest}} concluída! +{{points}} pts",
    msg_quest_complete_malus: "{{team}} - {{quest}} concluída! +{{points}} pts (−{{malus}} de malus de atraso)",
    msg_level_up: "{{team}} - Subiu de nível: {{level}}!",
    msg_level_up_short: "Subiu de nível: {{level}}!",
    msg_partial_quest_one: "{{team}} - {{quest}}: {{count}} imagem encontrada",
    msg_partial_quest_other: "{{team}} - {{quest}}: {{count}} imagens encontradas",
    reg_join_team_not_found: 'Equipa não encontrada',
  },
};

/**
 * ingame_clash - the player-facing Clash text the app owns: the clan
 * registration screen, the live match (punch feedback, purge announcement,
 * event feed) and the final results screen. All of it resolves against the
 * LAUNCH language, like every other bucket-2 string. Territory/clan NAMES come
 * from the scenario (bucket 3), not from here.
 */
const CLASH_BASELINE: Catalog = {
  fr: {
    title: 'Inscription des clans',
    back: 'Retour',
    intro_locked_one: 'Cette station inscrit un seul clan - les joueurs bipent leur puce ici pour le rejoindre.',
    intro_locked_many: 'Cette station inscrit uniquement les clans ci-dessous - choisissez-en un, puis les joueurs bipent leur puce pour le rejoindre.',
    intro_self: "Sélectionnez un clan sur cette station, puis les joueurs bipent leur puce pour le rejoindre. Laissez une station sur un clan pour en faire un lecteur d'inscription dédié.",
    intro_bulk: 'Les clans ont été formés au lancement (équipes prédéterminées). Vérifiez les effectifs ci-dessous, puis démarrez la partie.',
    no_assigned_clan: "Aucun clan ne correspond à l'affectation de cette station - demandez à l'opérateur de la mettre à jour depuis le panneau Appareils.",
    full: 'Complet',
    clan_fallback: 'Clan {{n}}',
    station_complete: 'Inscription terminée sur cette station',
    station_complete_one: 'Le clan affecté est complet.',
    station_complete_many: 'Tous les clans affectés sont complets.',
    bip_to_join: 'Bipez une puce pour rejoindre {{clan}}',
    select_clan_hint: 'Sélectionnez un clan ci-dessus pour commencer les inscriptions.',
    join_ok: '{{clan}} rejoint ✓',
    join_clan_full: 'Clan complet - choisissez un autre clan',
    join_already_in_clan: 'Déjà dans ce clan',
    join_already_other_clan: 'Cette puce appartient déjà à un autre clan',
    bulk_footer: 'Clans prédéterminés - les puces ont été distribuées au lancement. Les effectifs ci-dessus sont définitifs ; appuyez sur {{start}} quand vous êtes prêt.',
    start_game: 'Démarrer la partie',
    results_winner: "{{clan}} l'emporte !",
    results_draw: 'Égalité !',
    results_no_territory: 'Aucun territoire conquis',
    pts: 'pts',
    territories: 'Territoires',
    neutral: 'Neutre',
    territory_fallback: 'Territoire {{n}}',
    pts_per_min: 'pts/min',
    back_to_games: 'Retour aux parties',
    msg_not_registered: 'Puce non rattachée à un clan',
    msg_game_over: 'Partie terminée',
    msg_purge_already_used: 'Purge déjà utilisée par votre clan',
    msg_purge_own_territory: 'Impossible de purger votre propre territoire',
    msg_purge_no_target: 'Aucun territoire à purger pour le moment',
    msg_territory_incomplete: '{{territory}} incomplet',
    msg_territory_incomplete_generic: 'Territoire incomplet',
    msg_no_fresh_punch: 'Aucun bip nouveau - repique les balises',
    msg_missing_balises_one: 'il manque la balise {{list}}',
    msg_missing_balises_other: 'il manque les balises {{list}}',
    msg_territory_captured: '{{territory}} complété !',
    msg_territory_captured_generic: 'Territoire complété !',
    purge_announcement: 'a purgé {{territory}} !',
    purge_available: 'Purge disponible',
    purge_used: 'Purge utilisée',
    event_conquest: 'a conquis {{territory}} !',
    event_attack: 'attaque {{territory}} !',
    event_neutralized: 'a neutralisé {{territory}} !',
    event_other: '- {{territory}}',
    age_just_now: "à l'instant",
    age_minutes: 'il y a {{n}} min',
    age_hours: 'il y a {{n}} h',
    ranking_title: 'Classement des clans',
    rate_per_min: '+{{n}} pts/min',
  },
  en: {
    title: 'Clan registration',
    back: 'Back',
    intro_locked_one: 'This station registers one clan only - players bip their chip here to join it.',
    intro_locked_many: 'This station registers the clans below only - pick one, then players bip their chip to join it.',
    intro_self: 'Select a clan on this station, then players bip their chip to join it. Leave a station on one clan to use it as a dedicated join reader.',
    intro_bulk: 'Clans were formed at launch (predetermined teams). Review the counts below, then start the game.',
    no_assigned_clan: "No clan matches this station's assignment - ask the operator to update it from the Devices panel.",
    full: 'Full',
    clan_fallback: 'Clan {{n}}',
    station_complete: 'Registration complete on this station',
    station_complete_one: 'The assigned clan is full.',
    station_complete_many: 'All assigned clans are full.',
    bip_to_join: 'Bip a chip to join {{clan}}',
    select_clan_hint: 'Select a clan above to start enrolling players.',
    join_ok: 'Joined {{clan}} ✓',
    join_clan_full: 'Clan full - pick another clan',
    join_already_in_clan: 'Already in this clan',
    join_already_other_clan: 'Chip already belongs to another clan',
    bulk_footer: 'Predetermined clans - chips were dealt at launch. The counts above are final; press {{start}} when ready.',
    start_game: 'Start game',
    results_winner: '{{clan}} wins!',
    results_draw: 'Draw!',
    results_no_territory: 'No territory taken',
    pts: 'pts',
    territories: 'Territories',
    neutral: 'Neutral',
    territory_fallback: 'Territory {{n}}',
    pts_per_min: 'pts/min',
    back_to_games: 'Back to games',
    msg_not_registered: 'Chip not registered to a clan',
    msg_game_over: 'Game over',
    msg_purge_already_used: 'Purge already used by your clan',
    msg_purge_own_territory: 'You cannot purge your own territory',
    msg_purge_no_target: 'No territory to purge right now',
    msg_territory_incomplete: '{{territory}} incomplete',
    msg_territory_incomplete_generic: 'Territory incomplete',
    msg_no_fresh_punch: 'No new punch - punch the stations again',
    msg_missing_balises_one: 'still missing station {{list}}',
    msg_missing_balises_other: 'still missing stations {{list}}',
    msg_territory_captured: '{{territory}} complete!',
    msg_territory_captured_generic: 'Territory complete!',
    purge_announcement: 'purged {{territory}}!',
    purge_available: 'Purge available',
    purge_used: 'Purge used',
    event_conquest: 'conquered {{territory}}!',
    event_attack: 'is attacking {{territory}}!',
    event_neutralized: 'neutralised {{territory}}!',
    event_other: '- {{territory}}',
    age_just_now: 'just now',
    age_minutes: '{{n}} min ago',
    age_hours: '{{n}} h ago',
    ranking_title: 'Clan ranking',
    rate_per_min: '+{{n}} pts/min',
  },
  es: {
    title: 'Inscripción de clanes',
    back: 'Volver',
    intro_locked_one: 'Esta estación inscribe un solo clan: los jugadores pasan su tarjeta aquí para unirse.',
    intro_locked_many: 'Esta estación inscribe únicamente los clanes de abajo: elige uno y los jugadores pasan su tarjeta para unirse.',
    intro_self: 'Selecciona un clan en esta estación y los jugadores pasarán su tarjeta para unirse. Deja una estación fija en un clan para usarla como lector de inscripción.',
    intro_bulk: 'Los clanes se formaron al lanzar la partida (equipos predeterminados). Revisa los efectivos y empieza la partida.',
    no_assigned_clan: 'Ningún clan coincide con la asignación de esta estación: pide al operador que la actualice desde el panel Dispositivos.',
    full: 'Completo',
    clan_fallback: 'Clan {{n}}',
    station_complete: 'Inscripción completada en esta estación',
    station_complete_one: 'El clan asignado está completo.',
    station_complete_many: 'Todos los clanes asignados están completos.',
    bip_to_join: 'Pasa una tarjeta para unirte a {{clan}}',
    select_clan_hint: 'Selecciona un clan arriba para empezar a inscribir jugadores.',
    join_ok: '{{clan}}: unido ✓',
    join_clan_full: 'Clan completo: elige otro clan',
    join_already_in_clan: 'Ya está en este clan',
    join_already_other_clan: 'La tarjeta ya pertenece a otro clan',
    bulk_footer: 'Clanes predeterminados: las tarjetas se repartieron al lanzar. Los efectivos de arriba son definitivos; pulsa {{start}} cuando estés listo.',
    start_game: 'Empezar partida',
    results_winner: '¡{{clan}} gana!',
    results_draw: '¡Empate!',
    results_no_territory: 'Ningún territorio conquistado',
    pts: 'pts',
    territories: 'Territorios',
    neutral: 'Neutral',
    territory_fallback: 'Territorio {{n}}',
    pts_per_min: 'pts/min',
    back_to_games: 'Volver a las partidas',
    msg_not_registered: 'Tarjeta no asignada a ningún clan',
    msg_game_over: 'Partida terminada',
    msg_purge_already_used: 'Tu clan ya ha usado la purga',
    msg_purge_own_territory: 'No puedes purgar tu propio territorio',
    msg_purge_no_target: 'Ningún territorio que purgar por ahora',
    msg_territory_incomplete: '{{territory}} incompleto',
    msg_territory_incomplete_generic: 'Territorio incompleto',
    msg_no_fresh_punch: 'Ningún marcaje nuevo: vuelve a picar las balizas',
    msg_missing_balises_one: 'falta la baliza {{list}}',
    msg_missing_balises_other: 'faltan las balizas {{list}}',
    msg_territory_captured: '¡{{territory}} completado!',
    msg_territory_captured_generic: '¡Territorio completado!',
    purge_announcement: '¡ha purgado {{territory}}!',
    purge_available: 'Purga disponible',
    purge_used: 'Purga usada',
    event_conquest: '¡ha conquistado {{territory}}!',
    event_attack: '¡ataca {{territory}}!',
    event_neutralized: '¡ha neutralizado {{territory}}!',
    event_other: '- {{territory}}',
    age_just_now: 'ahora mismo',
    age_minutes: 'hace {{n}} min',
    age_hours: 'hace {{n}} h',
    ranking_title: 'Clasificación de clanes',
    rate_per_min: '+{{n}} pts/min',
  },
  de: {
    title: 'Clan-Anmeldung',
    back: 'Zurück',
    intro_locked_one: 'Diese Station meldet nur einen Clan an - Spieler stempeln hier ihre Karte, um beizutreten.',
    intro_locked_many: 'Diese Station meldet nur die unten stehenden Clans an - wähle einen aus, dann stempeln die Spieler ihre Karte zum Beitreten.',
    intro_self: 'Wähle auf dieser Station einen Clan, dann stempeln die Spieler ihre Karte zum Beitreten. Eine dauerhaft auf einen Clan gestellte Station dient als eigener Anmelde-Leser.',
    intro_bulk: 'Die Clans wurden beim Start gebildet (vorgegebene Teams). Prüfe die Zahlen unten und starte das Spiel.',
    no_assigned_clan: 'Kein Clan passt zur Zuweisung dieser Station - lass sie vom Betreiber im Geräte-Panel aktualisieren.',
    full: 'Voll',
    clan_fallback: 'Clan {{n}}',
    station_complete: 'Anmeldung auf dieser Station abgeschlossen',
    station_complete_one: 'Der zugewiesene Clan ist voll.',
    station_complete_many: 'Alle zugewiesenen Clans sind voll.',
    bip_to_join: 'Karte stempeln, um {{clan}} beizutreten',
    select_clan_hint: 'Wähle oben einen Clan, um Spieler anzumelden.',
    join_ok: '{{clan}} beigetreten ✓',
    join_clan_full: 'Clan voll - wähle einen anderen Clan',
    join_already_in_clan: 'Bereits in diesem Clan',
    join_already_other_clan: 'Karte gehört bereits zu einem anderen Clan',
    bulk_footer: 'Vorgegebene Clans - die Karten wurden beim Start verteilt. Die Zahlen oben sind endgültig; drücke {{start}}, wenn du bereit bist.',
    start_game: 'Spiel starten',
    results_winner: '{{clan}} gewinnt!',
    results_draw: 'Unentschieden!',
    results_no_territory: 'Kein Territorium erobert',
    pts: 'Pkt',
    territories: 'Territorien',
    neutral: 'Neutral',
    territory_fallback: 'Territorium {{n}}',
    pts_per_min: 'Pkt/Min',
    back_to_games: 'Zurück zu den Spielen',
    msg_not_registered: 'Karte keinem Clan zugeordnet',
    msg_game_over: 'Spiel beendet',
    msg_purge_already_used: 'Deine Sippe hat die Säuberung bereits genutzt',
    msg_purge_own_territory: 'Du kannst dein eigenes Territorium nicht säubern',
    msg_purge_no_target: 'Derzeit kein Territorium zum Säubern',
    msg_territory_incomplete: '{{territory}} unvollständig',
    msg_territory_incomplete_generic: 'Territorium unvollständig',
    msg_no_fresh_punch: 'Kein neuer Stempel - stemple die Stationen erneut',
    msg_missing_balises_one: 'es fehlt der Posten {{list}}',
    msg_missing_balises_other: 'es fehlen die Posten {{list}}',
    msg_territory_captured: '{{territory}} abgeschlossen!',
    msg_territory_captured_generic: 'Territorium abgeschlossen!',
    purge_announcement: 'hat {{territory}} gesäubert!',
    purge_available: 'Säuberung verfügbar',
    purge_used: 'Säuberung verbraucht',
    event_conquest: 'hat {{territory}} erobert!',
    event_attack: 'greift {{territory}} an!',
    event_neutralized: 'hat {{territory}} neutralisiert!',
    event_other: '- {{territory}}',
    age_just_now: 'gerade eben',
    age_minutes: 'vor {{n}} Min',
    age_hours: 'vor {{n}} Std',
    ranking_title: 'Clan-Rangliste',
    rate_per_min: '+{{n}} Pkt/Min',
  },
  it: {
    title: 'Iscrizione dei clan',
    back: 'Indietro',
    intro_locked_one: 'Questa postazione iscrive un solo clan: i giocatori passano qui la tessera per unirsi.',
    intro_locked_many: 'Questa postazione iscrive solo i clan qui sotto: scegline uno, poi i giocatori passano la tessera per unirsi.',
    intro_self: 'Seleziona un clan su questa postazione, poi i giocatori passano la tessera per unirsi. Lascia una postazione fissa su un clan per usarla come lettore di iscrizione.',
    intro_bulk: 'I clan sono stati formati al lancio (squadre predefinite). Controlla i numeri qui sotto, poi avvia la partita.',
    no_assigned_clan: "Nessun clan corrisponde all'assegnazione di questa postazione: chiedi all'operatore di aggiornarla dal pannello Dispositivi.",
    full: 'Al completo',
    clan_fallback: 'Clan {{n}}',
    station_complete: 'Iscrizione completata su questa postazione',
    station_complete_one: 'Il clan assegnato è al completo.',
    station_complete_many: 'Tutti i clan assegnati sono al completo.',
    bip_to_join: 'Passa una tessera per unirti a {{clan}}',
    select_clan_hint: 'Seleziona un clan qui sopra per iniziare a iscrivere i giocatori.',
    join_ok: '{{clan}}: iscritto ✓',
    join_clan_full: 'Clan al completo: scegli un altro clan',
    join_already_in_clan: 'Già in questo clan',
    join_already_other_clan: 'La tessera appartiene già a un altro clan',
    bulk_footer: 'Clan predefiniti: le tessere sono state distribuite al lancio. I numeri qui sopra sono definitivi; premi {{start}} quando sei pronto.',
    start_game: 'Avvia la partita',
    results_winner: '{{clan}} vince!',
    results_draw: 'Pareggio!',
    results_no_territory: 'Nessun territorio conquistato',
    pts: 'pt',
    territories: 'Territori',
    neutral: 'Neutrale',
    territory_fallback: 'Territorio {{n}}',
    pts_per_min: 'pt/min',
    back_to_games: 'Torna alle partite',
    msg_not_registered: 'Tessera non assegnata a un clan',
    msg_game_over: 'Partita terminata',
    msg_purge_already_used: 'Il tuo clan ha già usato la purga',
    msg_purge_own_territory: 'Non puoi purgare il tuo territorio',
    msg_purge_no_target: 'Nessun territorio da purgare per ora',
    msg_territory_incomplete: '{{territory}} incompleto',
    msg_territory_incomplete_generic: 'Territorio incompleto',
    msg_no_fresh_punch: 'Nessuna nuova punzonatura - ripunzona le lanterne',
    msg_missing_balises_one: 'manca la lanterna {{list}}',
    msg_missing_balises_other: 'mancano le lanterne {{list}}',
    msg_territory_captured: '{{territory}} completato!',
    msg_territory_captured_generic: 'Territorio completato!',
    purge_announcement: 'ha purgato {{territory}}!',
    purge_available: 'Purga disponibile',
    purge_used: 'Purga usata',
    event_conquest: 'ha conquistato {{territory}}!',
    event_attack: 'attacca {{territory}}!',
    event_neutralized: 'ha neutralizzato {{territory}}!',
    event_other: '- {{territory}}',
    age_just_now: 'proprio ora',
    age_minutes: '{{n}} min fa',
    age_hours: '{{n}} h fa',
    ranking_title: 'Classifica dei clan',
    rate_per_min: '+{{n}} pt/min',
  },
  pt: {
    title: 'Inscrição dos clãs',
    back: 'Voltar',
    intro_locked_one: 'Esta estação inscreve apenas um clã - os jogadores picam aqui o seu cartão para entrar.',
    intro_locked_many: 'Esta estação inscreve apenas os clãs abaixo - escolha um e os jogadores picam o cartão para entrar.',
    intro_self: 'Selecione um clã nesta estação e os jogadores picam o cartão para entrar. Deixe uma estação fixa num clã para a usar como leitor de inscrição.',
    intro_bulk: 'Os clãs foram formados no lançamento (equipas predefinidas). Verifique os números abaixo e inicie o jogo.',
    no_assigned_clan: 'Nenhum clã corresponde à atribuição desta estação - peça ao operador para a atualizar no painel Dispositivos.',
    full: 'Completo',
    clan_fallback: 'Clã {{n}}',
    station_complete: 'Inscrição concluída nesta estação',
    station_complete_one: 'O clã atribuído está completo.',
    station_complete_many: 'Todos os clãs atribuídos estão completos.',
    bip_to_join: 'Pique um cartão para entrar em {{clan}}',
    select_clan_hint: 'Selecione um clã acima para começar a inscrever jogadores.',
    join_ok: '{{clan}}: entrou ✓',
    join_clan_full: 'Clã completo - escolha outro clã',
    join_already_in_clan: 'Já está neste clã',
    join_already_other_clan: 'O cartão já pertence a outro clã',
    bulk_footer: 'Clãs predefinidos - os cartões foram distribuídos no lançamento. Os números acima são definitivos; prima {{start}} quando estiver pronto.',
    start_game: 'Iniciar jogo',
    results_winner: '{{clan}} vence!',
    results_draw: 'Empate!',
    results_no_territory: 'Nenhum território conquistado',
    pts: 'pts',
    territories: 'Territórios',
    neutral: 'Neutro',
    territory_fallback: 'Território {{n}}',
    pts_per_min: 'pts/min',
    back_to_games: 'Voltar aos jogos',
    msg_not_registered: 'Cartão não associado a nenhum clã',
    msg_game_over: 'Jogo terminado',
    msg_purge_already_used: 'O teu clã já usou a purga',
    msg_purge_own_territory: 'Não podes purgar o teu próprio território',
    msg_purge_no_target: 'Nenhum território a purgar de momento',
    msg_territory_incomplete: '{{territory}} incompleto',
    msg_territory_incomplete_generic: 'Território incompleto',
    msg_no_fresh_punch: 'Nenhuma picagem nova - pique as balizas de novo',
    msg_missing_balises_one: 'falta a baliza {{list}}',
    msg_missing_balises_other: 'faltam as balizas {{list}}',
    msg_territory_captured: '{{territory}} concluído!',
    msg_territory_captured_generic: 'Território concluído!',
    purge_announcement: 'purgou {{territory}}!',
    purge_available: 'Purga disponível',
    purge_used: 'Purga usada',
    event_conquest: 'conquistou {{territory}}!',
    event_attack: 'ataca {{territory}}!',
    event_neutralized: 'neutralizou {{territory}}!',
    event_other: '- {{territory}}',
    age_just_now: 'agora mesmo',
    age_minutes: 'há {{n}} min',
    age_hours: 'há {{n}} h',
    ranking_title: 'Classificação dos clãs',
    rate_per_min: '+{{n}} pts/min',
  },
};

/**
 * ingame_tracks - the player-facing Track text the app owns: the two HUD frame
 * captions, the simple-mode summary line, the feedback-image legend rows, and
 * the not-empty-card dialogue at the start reader. Resolves against the team language like every bucket-2
 * string. Checkpoint names/descriptions come from the scenario (bucket 3).
 */
const TRACKS_BASELINE: Catalog = {
  fr: {
    hud_time: 'Temps',
    hud_score: 'Score',
    summary_checkpoints: '{{hit}} / {{total}} points de contrôle',
    card_not_empty_hold: "Votre puce n'est pas vide. Bipez-la à nouveau pour récupérer votre parcours, ou effacez-la puis bipez pour démarrer.",
    card_recovered: 'Parcours récupéré sur la puce',
    no_station_match: "Aucun poinçon de la puce ne correspond aux points de contrôle - vérifiez le modèle associé au scénario.",
    player_starts: "C'est parti ! {{team}}",
    card_not_empty_warn: "⚠️ Votre puce n'est pas vide, effacez votre puce",
    legend_wrong_order: 'Mauvais ordre',
    legend_missing_checkpoint: 'Point de contrôle manquant',
  },
  en: {
    hud_time: 'Time',
    hud_score: 'Score',
    summary_checkpoints: '{{hit}} / {{total}} checkpoints',
    card_not_empty_hold: 'Your card is not empty. Bip it again to recover your run, or wipe it and bip to start.',
    card_recovered: 'Run recovered from the card',
    no_station_match: 'None of the card punches match a checkpoint - check the pattern bound to this scenario.',
    player_starts: "Here we go! {{team}}",
    card_not_empty_warn: "⚠️ Your card is not empty, wipe it",
    legend_wrong_order: 'Wrong order',
    legend_missing_checkpoint: 'Missing checkpoint',
  },
  es: {
    hud_time: 'Tiempo',
    hud_score: 'Puntuación',
    summary_checkpoints: '{{hit}} / {{total}} puntos de control',
    card_not_empty_hold: 'Tu tarjeta no está vacía. Pásala de nuevo para recuperar tu recorrido, o bórrala y pásala para empezar.',
    card_recovered: 'Recorrido recuperado de la tarjeta',
    no_station_match: 'Ningún marcaje de la tarjeta coincide con un punto de control: revisa el modelo asociado al escenario.',
    player_starts: "¡Empezamos! {{team}}",
    card_not_empty_warn: "⚠️ Tu tarjeta no está vacía, bórrala",
    legend_wrong_order: 'Orden incorrecto',
    legend_missing_checkpoint: 'Punto de control faltante',
  },
  de: {
    hud_time: 'Zeit',
    hud_score: 'Punkte',
    summary_checkpoints: '{{hit}} / {{total}} Posten',
    card_not_empty_hold: 'Deine Karte ist nicht leer. Stemple sie erneut, um deinen Lauf zu übernehmen, oder lösche sie und stemple zum Start.',
    card_recovered: 'Lauf von der Karte übernommen',
    no_station_match: 'Kein Stempel der Karte passt zu einem Posten - prüfe das Muster dieses Szenarios.',
    player_starts: "Los geht's! {{team}}",
    card_not_empty_warn: "⚠️ Deine Karte ist nicht leer, bitte löschen",
    legend_wrong_order: 'Falsche Reihenfolge',
    legend_missing_checkpoint: 'Fehlender Posten',
  },
  it: {
    hud_time: 'Tempo',
    hud_score: 'Punteggio',
    summary_checkpoints: '{{hit}} / {{total}} punti di controllo',
    card_not_empty_hold: 'La tua tessera non è vuota. Passala di nuovo per recuperare il percorso, oppure cancellala e passala per iniziare.',
    card_recovered: 'Percorso recuperato dalla tessera',
    no_station_match: 'Nessuna punzonatura della tessera corrisponde a un punto di controllo: controlla il modello associato allo scenario.',
    player_starts: "Si parte! {{team}}",
    card_not_empty_warn: "⚠️ La tua tessera non è vuota, cancellala",
    legend_wrong_order: 'Ordine errato',
    legend_missing_checkpoint: 'Punto di controllo mancante',
  },
  pt: {
    hud_time: 'Tempo',
    hud_score: 'Pontuação',
    summary_checkpoints: '{{hit}} / {{total}} pontos de controlo',
    card_not_empty_hold: 'O seu cartão não está vazio. Pique-o novamente para recuperar o percurso, ou apague-o e pique para começar.',
    card_recovered: 'Percurso recuperado do cartão',
    no_station_match: 'Nenhuma picagem do cartão corresponde a um ponto de controlo - verifique o modelo associado ao cenário.',
    player_starts: "Vamos lá! {{team}}",
    card_not_empty_warn: "⚠️ O seu cartão não está vazio, apague-o",
    legend_wrong_order: 'Ordem errada',
    legend_missing_checkpoint: 'Ponto de controlo em falta',
  },
};

/**
 * ingame_mystery - the built-in fallbacks for the Mystery start bip. A scenario
 * can override each of them from the editor's "UI text strings" section
 * (`text_player_starts` / `text_team_starts_card_not_empty`); these are what
 * plays when the author left them blank. `{{team}}` is the team name.
 */
const MYSTERY_BASELINE: Catalog = {
  fr: {
    player_starts: "C'est parti ! {{team}}",
    player_starts_card_not_empty: "C'est parti ! {{team}} - ⚠️ Votre puce n'est pas vide, effacez votre puce",
  },
  en: {
    player_starts: "Here we go! {{team}}",
    player_starts_card_not_empty: "Here we go! {{team}} - ⚠️ Your card is not empty, wipe it",
  },
  es: {
    player_starts: '¡Empezamos! {{team}}',
    player_starts_card_not_empty: '¡Empezamos! {{team}} - ⚠️ Tu tarjeta no está vacía, bórrala',
  },
  de: {
    player_starts: "Los geht's! {{team}}",
    player_starts_card_not_empty: "Los geht's! {{team}} - ⚠️ Deine Karte ist nicht leer, bitte löschen",
  },
  it: {
    player_starts: 'Si parte! {{team}}',
    player_starts_card_not_empty: 'Si parte! {{team}} - ⚠️ La tua tessera non è vuota, cancellala',
  },
  pt: {
    player_starts: 'Vamos lá! {{team}}',
    player_starts_card_not_empty: 'Vamos lá! {{team}} - ⚠️ O seu cartão não está vazio, apague-o',
  },
};

const BASELINES: Record<IngameNamespace, Catalog> = {
  ingame_common: COMMON_BASELINE,
  ingame_tagquest: TAGQUEST_BASELINE,
  ingame_mystery: MYSTERY_BASELINE,
  ingame_tracks: TRACKS_BASELINE,
  ingame_clash: CLASH_BASELINE,
};

/** Register the bundled baselines. Idempotent; never overwrites synced overlays. */
export function registerIngameBaselines(): void {
  for (const ns of INGAME_NAMESPACES) {
    const catalog = BASELINES[ns];
    for (const [lang, entries] of Object.entries(catalog)) {
      i18n.addResourceBundle(lang, ns, entries, /*deep*/ true, /*overwrite*/ false);
    }
  }
}

/**
 * Legacy store key → namespace. The studio backend still publishes the four
 * tagquest HUD labels under `tagquest_translations`; until it is renamed to the
 * per-namespace keys, we read the legacy key and overlay it onto `ingame_tagquest`
 * so the consolidation works against the current backend with no PHP change.
 */
const LEGACY_STORE_KEYS: Partial<Record<IngameNamespace, string>> = {
  ingame_tagquest: 'tagquest_translations',
};

/**
 * Overlay the synced admin translations on top of the baselines. Call after each
 * sync cycle. Synced values win (overwrite:true). Tolerant of missing/malformed
 * blobs - a bad row just leaves the baseline in place. Reads the new namespace
 * key first, then the legacy key as a fallback for the same namespace.
 */
export async function hydrateIngameFromStore(): Promise<void> {
  for (const ns of INGAME_STORE_KEYS) {
    const keys = [ns, LEGACY_STORE_KEYS[ns]].filter(Boolean) as string[];
    for (const storeKey of keys) {
      const catalog = normalizeBlob(await translationsStore.getValue<unknown>(storeKey));
      if (!catalog) continue;
      for (const [lang, entries] of Object.entries(catalog)) {
        i18n.addResourceBundle(lang, ns, entries, /*deep*/ true, /*overwrite*/ true);
      }
    }
  }
}

/**
 * Synced blobs are authored key→lang→value (the studio admin grid shape); the
 * i18next resource is lang→key→value. Accept either and normalize to the latter.
 * Returns null for unusable input.
 */
function normalizeBlob(blob: unknown): Catalog | null {
  if (!blob || typeof blob !== 'object') return null;
  const out: Catalog = {};
  for (const [outer, inner] of Object.entries(blob as Record<string, unknown>)) {
    if (!inner || typeof inner !== 'object') continue;
    for (const [innerKey, val] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof val !== 'string') continue;
      // key→lang→value  (outer=key, innerKey=lang)  OR  lang→key→value.
      // Heuristic: a 2-letter innerKey that is NOT also a top-level key → outer
      // is the key, innerKey is the lang. Otherwise treat outer as the lang.
      const looksLikeKeyFirst = innerKey.length <= 3 && !(innerKey in (blob as object));
      const lang = looksLikeKeyFirst ? innerKey : outer;
      const key = looksLikeKeyFirst ? outer : innerKey;
      (out[lang] ??= {})[key] = normalizePlaceholders(val);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize the `{s}`/`{n}` interpolation tokens to i18next's `{{s}}`/`{{n}}`,
 * tolerating legacy single-brace data saved before the migration. Idempotent:
 * already-doubled tokens are left unchanged.
 */
function normalizePlaceholders(value: string): string {
  return value.replace(/\{\{?([sn])\}?\}/g, '{{$1}}');
}

/**
 * Resolve an in-game string against a specific (team) language, independent of
 * the operator chrome language. Falls back lang → `en` (pivot) → raw key via
 * i18next's own fallback. `vars` feed `{{var}}` interpolation.
 */
export function tIngame(
  ns: IngameNamespace,
  key: string,
  lang: string,
  vars?: Record<string, string | number>,
): string {
  const fixedT = i18n.getFixedT(lang || PIVOT_LANG, ns);
  return fixedT(key, vars ?? {});
}
