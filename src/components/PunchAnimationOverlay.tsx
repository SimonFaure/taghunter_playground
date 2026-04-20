import { useEffect, useState, useRef } from 'react';
import { Check, X, Star, Trophy } from 'lucide-react';
import type { PunchAnimationData } from '../services/tagquestPunchLogic';

interface Props {
  data: PunchAnimationData;
  onDone: () => void;
}

type Phase =
  | 'enter'          // fade in with prev state
  | 'images'         // reveal slot images one by one
  | 'main'           // show main image (complete quests only)
  | 'update'         // update score / combos / quest details
  | 'exit';          // fade out

const SLOT_STAGGER_MS = 400;
const MAIN_IMAGE_HOLD_MS = 1800;
const UPDATE_HOLD_MS = 2000;
const EXIT_MS = 600;

export function PunchAnimationOverlay({ data, onDone }: Props) {
  const { displayQuest, prevScore, newScore, prevCombos, newCombos, prevQuestDetails, newQuestDetails, teamName } = data;

  const [phase, setPhase] = useState<Phase>('enter');
  const [revealedSlots, setRevealedSlots] = useState(0);
  const [showMain, setShowMain] = useState(false);
  const [showUpdated, setShowUpdated] = useState(false);
  const [displayedScore, setDisplayedScore] = useState(prevScore);
  const [displayedCombos, setDisplayedCombos] = useState(prevCombos);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const slots = displayQuest?.slots ?? [];
  const isComplete = displayQuest?.complete ?? false;

  const set = (fn: () => void, ms: number) => {
    timerRef.current = setTimeout(fn, ms);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (phase === 'enter') {
      set(() => setPhase('images'), 800);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'images') return;
    if (slots.length === 0) {
      setPhase(isComplete ? 'main' : 'update');
      return;
    }
    if (revealedSlots < slots.length) {
      set(() => setRevealedSlots(prev => prev + 1), SLOT_STAGGER_MS);
    } else {
      set(() => setPhase(isComplete ? 'main' : 'update'), 600);
    }
  }, [phase, revealedSlots, slots.length, isComplete]);

  useEffect(() => {
    if (phase === 'main') {
      setShowMain(true);
      set(() => setPhase('update'), MAIN_IMAGE_HOLD_MS);
    }
  }, [phase]);

  useEffect(() => {
    if (phase === 'update') {
      setDisplayedScore(prevScore);
      setDisplayedCombos(prevCombos);

      if (newScore !== prevScore) {
        const steps = 20;
        const stepMs = Math.floor(900 / steps);
        let step = 0;
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => {
          step++;
          const progress = step / steps;
          const eased = 1 - Math.pow(1 - progress, 3);
          setDisplayedScore(Math.round(prevScore + (newScore - prevScore) * eased));
          setDisplayedCombos({
            combos6: Math.round(prevCombos.combos6 + (newCombos.combos6 - prevCombos.combos6) * eased),
            combos4: Math.round(prevCombos.combos4 + (newCombos.combos4 - prevCombos.combos4) * eased),
            combos2: Math.round(prevCombos.combos2 + (newCombos.combos2 - prevCombos.combos2) * eased),
          });
          if (step >= steps) {
            clearInterval(intervalRef.current!);
            setDisplayedScore(newScore);
            setDisplayedCombos(newCombos);
            setShowUpdated(true);
          }
        }, stepMs);
      } else {
        setDisplayedScore(newScore);
        setDisplayedCombos(newCombos);
        setShowUpdated(true);
      }

      set(() => setPhase('exit'), UPDATE_HOLD_MS);
    }
  }, [phase]);

  useEffect(() => {
    if (phase === 'exit') {
      set(onDone, EXIT_MS);
    }
  }, [phase, onDone]);

  const questDetails = showUpdated ? newQuestDetails : prevQuestDetails;
  const totalCombos = displayedCombos.combos6 + displayedCombos.combos4 + displayedCombos.combos2;

  const isExiting = phase === 'exit';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 5000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.82)',
        transition: `opacity ${EXIT_MS}ms ease`,
        opacity: isExiting ? 0 : 1,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '24px',
          width: '100%',
          maxWidth: '960px',
          padding: '32px 24px',
          transition: `opacity ${EXIT_MS}ms ease, transform ${EXIT_MS}ms ease`,
          opacity: isExiting ? 0 : 1,
          transform: isExiting ? 'scale(0.96) translateY(8px)' : 'scale(1) translateY(0)',
        }}
      >
        {/* Team name */}
        <div
          style={{
            fontSize: '2rem',
            fontWeight: 800,
            color: '#fff',
            letterSpacing: '-0.02em',
            textAlign: 'center',
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            opacity: phase === 'enter' ? 0 : 1,
            transform: phase === 'enter' ? 'translateY(-12px)' : 'translateY(0)',
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          {teamName}
        </div>

        <div style={{ display: 'flex', gap: '24px', width: '100%', alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>

          {/* Left panel — score + combos + quest details */}
          <div
            style={{
              background: 'rgba(15,23,42,0.9)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '16px',
              padding: '20px',
              minWidth: '200px',
              flex: '0 0 auto',
              opacity: phase === 'enter' ? 0 : 1,
              transform: phase === 'enter' ? 'translateX(-20px)' : 'translateX(0)',
              transition: 'opacity 0.4s ease 0.1s, transform 0.4s ease 0.1s',
            }}
          >
            {/* Score */}
            <div style={{ marginBottom: '16px', textAlign: 'center' }}>
              <div style={{ color: '#94a3b8', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '4px' }}>Score</div>
              <div
                style={{
                  fontSize: '2.8rem',
                  fontWeight: 800,
                  color: showUpdated && newScore !== prevScore ? '#4ade80' : '#fff',
                  lineHeight: 1,
                  transition: 'color 0.4s ease',
                }}
              >
                {displayedScore}
                <span style={{ fontSize: '1rem', color: '#64748b', fontWeight: 500, marginLeft: '4px' }}>pts</span>
              </div>
              {showUpdated && newScore !== prevScore && (
                <div style={{ color: '#4ade80', fontSize: '0.85rem', fontWeight: 700, marginTop: '4px' }}>
                  +{newScore - prevScore}
                </div>
              )}
            </div>

            {/* Combos */}
            {(totalCombos > 0 || (newCombos.combos6 + newCombos.combos4 + newCombos.combos2) > 0) && (
              <div style={{ marginBottom: '16px', padding: '10px', background: 'rgba(251,191,36,0.1)', borderRadius: '10px', border: '1px solid rgba(251,191,36,0.25)', textAlign: 'center' }}>
                <div style={{ color: '#fbbf24', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Star size={10} />
                  Combos
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                  {displayedCombos.combos6 > 0 && (
                    <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.85rem' }}>×6: {displayedCombos.combos6}</span>
                  )}
                  {displayedCombos.combos4 > 0 && (
                    <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.85rem' }}>×4: {displayedCombos.combos4}</span>
                  )}
                  {displayedCombos.combos2 > 0 && (
                    <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.85rem' }}>×2: {displayedCombos.combos2}</span>
                  )}
                </div>
              </div>
            )}

            {/* Quest details */}
            {questDetails.length > 0 && (
              <div>
                <div style={{ color: '#94a3b8', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Trophy size={10} />
                  Quests
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {questDetails.map(qd => (
                    <div key={qd.questIndex} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ color: '#cbd5e1', fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{qd.name}</span>
                      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                        <span style={{ color: '#64748b', fontSize: '0.7rem' }}>×{qd.timesCompleted}</span>
                        <span style={{ color: '#4ade80', fontSize: '0.7rem', fontWeight: 700 }}>{qd.totalPoints}pts</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right panel — quest image reveal */}
          {displayQuest && (
            <div
              style={{
                flex: '1 1 auto',
                maxWidth: '520px',
                opacity: phase === 'enter' ? 0 : 1,
                transform: phase === 'enter' ? 'translateX(20px)' : 'translateX(0)',
                transition: 'opacity 0.4s ease 0.15s, transform 0.4s ease 0.15s',
              }}
            >
              {/* Quest name */}
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: '1.1rem' }}>{displayQuest.name}</div>
                <div style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '2px' }}>
                  {displayQuest.complete ? (
                    <span style={{ color: '#4ade80', fontWeight: 700 }}>Quest Complete! +{displayQuest.points} pts</span>
                  ) : (
                    <span>{displayQuest.slots.filter(s => s.matched).length} / {displayQuest.slots.length} found</span>
                  )}
                </div>
              </div>

              {/* Main image reveal (complete only) */}
              {showMain && displayQuest.main_image && (
                <div
                  style={{
                    position: 'relative',
                    marginBottom: '16px',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    border: '2px solid rgba(74,222,128,0.5)',
                    boxShadow: '0 0 40px rgba(74,222,128,0.3)',
                    opacity: showMain ? 1 : 0,
                    transform: showMain ? 'scale(1)' : 'scale(0.9)',
                    transition: 'opacity 0.5s ease, transform 0.5s ease',
                  }}
                >
                  <img
                    src={displayQuest.main_image}
                    alt={displayQuest.name}
                    style={{ width: '100%', display: 'block', maxHeight: '240px', objectFit: 'cover' }}
                  />
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.2)',
                  }}>
                    <div style={{
                      background: 'rgba(74,222,128,0.9)',
                      borderRadius: '50%',
                      width: '56px',
                      height: '56px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Check size={32} color="#fff" strokeWidth={3} />
                    </div>
                  </div>
                </div>
              )}

              {/* Slot images grid */}
              {slots.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: slots.length <= 2 ? `repeat(${slots.length}, 1fr)` : 'repeat(2, 1fr)',
                    gap: '10px',
                  }}
                >
                  {slots.map((slot, i) => {
                    const revealed = i < revealedSlots;
                    return (
                      <div
                        key={slot.key}
                        style={{
                          position: 'relative',
                          borderRadius: '10px',
                          overflow: 'hidden',
                          border: revealed
                            ? slot.matched
                              ? '2px solid rgba(74,222,128,0.7)'
                              : '2px solid rgba(248,113,113,0.7)'
                            : '2px solid rgba(255,255,255,0.08)',
                          background: '#0f172a',
                          aspectRatio: '1',
                          opacity: revealed ? 1 : 0.15,
                          transform: revealed ? 'scale(1)' : 'scale(0.9)',
                          transition: 'opacity 0.35s ease, transform 0.35s ease, border-color 0.3s ease',
                          boxShadow: revealed
                            ? slot.matched
                              ? '0 0 16px rgba(74,222,128,0.25)'
                              : '0 0 16px rgba(248,113,113,0.2)'
                            : 'none',
                        }}
                      >
                        {slot.src ? (
                          <img
                            src={slot.src}
                            alt=""
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              display: 'block',
                              filter: revealed && !slot.matched ? 'grayscale(60%) brightness(0.5)' : 'none',
                              transition: 'filter 0.3s ease',
                            }}
                          />
                        ) : (
                          <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.05)' }} />
                        )}
                        {revealed && (
                          <div
                            style={{
                              position: 'absolute',
                              inset: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background: slot.matched ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.18)',
                            }}
                          >
                            <div
                              style={{
                                background: slot.matched ? 'rgba(74,222,128,0.85)' : 'rgba(248,113,113,0.85)',
                                borderRadius: '50%',
                                width: '36px',
                                height: '36px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                              }}
                            >
                              {slot.matched
                                ? <Check size={20} color="#fff" strokeWidth={3} />
                                : <X size={20} color="#fff" strokeWidth={3} />
                              }
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
