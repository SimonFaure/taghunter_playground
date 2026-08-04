import type { GameConfig } from '../components/LaunchGameModal';

/**
 * Build a {@link GameConfig} from a launched game's meta bag.
 *
 * The launched_games meta is a flat `Record<string,string>`; this is the single
 * place that parses it back into the typed config the renderers consume. Used at
 * launch time (LaunchedGamesList.handlePlayGame) AND when re-reading config after
 * an in-game config edit (GamePage), so both paths stay in sync.
 *
 * `name`/`numberOfTeams` aren't reliably present in meta, so the caller passes
 * them explicitly (from the launched_games row / the current config).
 */
export function gameConfigFromMeta(
  metaMap: Record<string, string>,
  base: { name: string; numberOfTeams: number },
): GameConfig {
  return {
    name: base.name,
    numberOfTeams: base.numberOfTeams,
    firstChipIndex: parseInt(metaMap.firstChipIndex || '1'),
    pattern: metaMap.pattern || '',
    duration: parseInt(metaMap.duration || '0'),
    messageDisplayDuration: parseInt(metaMap.messageDisplayDuration || '5'),
    enigmaImageDisplayDuration: parseInt(metaMap.enigmaImageDisplayDuration || '1'),
    colorblindMode: metaMap.colorblindMode === 'true',
    autoResetTeam: metaMap.autoResetTeam !== 'false',
    delayBeforeReset: parseInt(metaMap.delayBeforeReset || '2'),
    enterToReset: metaMap.enterToReset === 'true',
    showIdleLayout: metaMap.showIdleLayout !== 'false',
    idleSubtitle: metaMap.idleSubtitle ?? undefined,
    malusPerMinute: metaMap.malusPerMinute != null ? parseInt(metaMap.malusPerMinute) : undefined,
    autoRegisterTeam: metaMap.autoRegisterTeam === 'true',
    reuseCards: metaMap.reuseCards === 'true',
    selfRegisterTeam: metaMap.selfRegisterTeam === 'true',
    // Mystery/tracks "Départ groupé": the roster was stamped started at launch.
    massStart: metaMap.massStart === 'true',
    reuseDelayMinutes: parseInt(metaMap.reuseDelayMinutes || '5'),
    useNamePool: metaMap.useNamePool === 'true',
    namePoolAudience: (metaMap.namePoolAudience as GameConfig['namePoolAudience']) || undefined,
    addRandomNameOption: metaMap.addRandomNameOption === 'true',
    allowPlayerLanguageChoice: metaMap.allowPlayerLanguageChoice === 'true',
    scenarioLanguages: metaMap.availableLanguages ? metaMap.availableLanguages.split(',') : undefined,
    language: metaMap.language || undefined,
    visibilityHideDelaySec: parseInt(metaMap.visibilityHideDelaySec || '10'),
    testMode: metaMap.testMode === 'true',
    victoryType: (metaMap.victoryType as 'speed' | 'score') || undefined,
    playMode: (metaMap.playMode as 'solo' | 'team') || undefined,
    tagquestSelfRegister: metaMap.tagquestSelfRegister === 'true',
    // Missing key ⇒ true: games launched before the flag existed keep the ghost.
    tagquestShowQuestPreview: metaMap.tagquestShowQuestPreview !== 'false',
    // Missing key ⇒ false: games launched before the option keep raw scores.
    tagquestScoreWeighting: metaMap.tagquestScoreWeighting === 'true',
    cluesPage: metaMap.cluesPage ? JSON.parse(metaMap.cluesPage) : undefined,
    // Mystery/tracks first-bip videos. Re-derived here so re-entering a game
    // (Play button) or reloading after a config edit doesn't silently drop the
    // overlay. Missing key ⇒ false: games launched before the keys existed
    // behave exactly as they did.
    playTutorialOnBip: metaMap.playTutorialOnBip === 'true',
    playIntroOnBip: metaMap.playIntroOnBip === 'true',
    // Tracks: the route (primary + enabled set) and display/play/score modes.
    // Read here so an in-game config edit re-derives the live tracks config.
    route: metaMap.route || undefined,
    routes: metaMap.tracks_routes ? metaMap.tracks_routes.split(',').filter(Boolean) : undefined,
    tracksRoutes: metaMap.tracks_routes ? metaMap.tracks_routes.split(',').filter(Boolean) : undefined,
    displayMode: metaMap.displayMode || undefined,
    trackPlayMode: (metaMap.trackPlayMode as 'itinerary' | 'free') || undefined,
    scoreType: (metaMap.scoreType as 'percentage' | 'points') || undefined,
  };
}
