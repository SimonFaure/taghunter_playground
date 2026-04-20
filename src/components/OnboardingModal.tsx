import { useState } from 'react';
import { Rocket, Monitor, PlayCircle, Mail, Check, ArrowRight } from 'lucide-react';

interface OnboardingModalProps {
  onComplete: (settings: {
    fullscreenOnLaunch: boolean;
    autoLaunch: boolean;
    email: string;
  }) => void;
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [step, setStep] = useState(1);
  const [fullscreenOnLaunch, setFullscreenOnLaunch] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [email, setEmail] = useState('');

  const handleComplete = () => {
    if (!email.trim()) {
      return;
    }
    onComplete({ fullscreenOnLaunch, autoLaunch, email });
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl shadow-2xl max-w-2xl w-full border border-slate-700/50 overflow-hidden">
        {step === 1 ? (
          <div className="p-10">
            <div className="flex justify-center mb-8">
              <div className="bg-gradient-to-br from-blue-500 to-cyan-500 p-4 rounded-2xl">
                <Rocket className="text-white" size={48} />
              </div>
            </div>

            <h1 className="text-4xl font-bold text-center mb-4 bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
              Welcome to Taghunter Playground
            </h1>

            <p className="text-center text-slate-300 text-lg mb-12">
              Let's set up your experience in just a few seconds
            </p>

            <div className="grid grid-cols-3 gap-4 mb-12">
              <div className="bg-slate-700/30 p-6 rounded-xl border border-slate-600/50 text-center">
                <Monitor className="text-blue-400 mx-auto mb-3" size={32} />
                <p className="text-sm text-slate-300">Display</p>
              </div>
              <div className="bg-slate-700/30 p-6 rounded-xl border border-slate-600/50 text-center">
                <PlayCircle className="text-cyan-400 mx-auto mb-3" size={32} />
                <p className="text-sm text-slate-300">Startup</p>
              </div>
              <div className="bg-slate-700/30 p-6 rounded-xl border border-slate-600/50 text-center">
                <Mail className="text-green-400 mx-auto mb-3" size={32} />
                <p className="text-sm text-slate-300">Contact</p>
              </div>
            </div>

            <button
              onClick={() => setStep(2)}
              className="w-full flex items-center justify-center gap-2 px-8 py-4 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 rounded-xl transition-all font-semibold text-lg shadow-lg hover:shadow-xl transform hover:scale-[1.02]"
            >
              Get Started
              <ArrowRight size={20} />
            </button>
          </div>
        ) : (
          <div className="p-10">
            <div className="flex justify-center mb-6">
              <div className="bg-gradient-to-br from-blue-500 to-cyan-500 p-3 rounded-xl">
                <Rocket className="text-white" size={32} />
              </div>
            </div>

            <h2 className="text-3xl font-bold text-center mb-3">
              Customize Your Experience
            </h2>

            <p className="text-center text-slate-400 mb-10">
              Choose your preferences
            </p>

            <div className="space-y-6 mb-10">
              <div className="bg-slate-700/30 p-6 rounded-xl border-2 border-slate-600/50 hover:border-blue-500/50 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="bg-blue-500/10 p-3 rounded-lg">
                      <Monitor className="text-blue-400" size={24} />
                    </div>
                    <div>
                      <div className="font-semibold text-lg">Fullscreen Mode</div>
                      <div className="text-sm text-slate-400">Launch in fullscreen for immersive experience</div>
                    </div>
                  </div>
                  <button
                    onClick={() => setFullscreenOnLaunch(!fullscreenOnLaunch)}
                    className={`relative inline-flex h-8 w-16 items-center rounded-full transition-colors ${
                      fullscreenOnLaunch ? 'bg-blue-600' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                        fullscreenOnLaunch ? 'translate-x-9' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="bg-slate-700/30 p-6 rounded-xl border-2 border-slate-600/50 hover:border-cyan-500/50 transition-all">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="bg-cyan-500/10 p-3 rounded-lg">
                      <PlayCircle className="text-cyan-400" size={24} />
                    </div>
                    <div>
                      <div className="font-semibold text-lg">Auto-Launch</div>
                      <div className="text-sm text-slate-400">Start automatically when your computer boots</div>
                    </div>
                  </div>
                  <button
                    onClick={() => setAutoLaunch(!autoLaunch)}
                    className={`relative inline-flex h-8 w-16 items-center rounded-full transition-colors ${
                      autoLaunch ? 'bg-cyan-600' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                        autoLaunch ? 'translate-x-9' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="bg-slate-700/30 p-6 rounded-xl border-2 border-slate-600/50 hover:border-green-500/50 transition-all">
                <div className="flex items-center gap-4 mb-4">
                  <div className="bg-green-500/10 p-3 rounded-lg">
                    <Mail className="text-green-400" size={24} />
                  </div>
                  <div>
                    <div className="font-semibold text-lg">Email Address</div>
                    <div className="text-sm text-slate-400">Required for syncing scenarios from the server</div>
                  </div>
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-600 rounded-lg focus:outline-none focus:border-green-500 transition-colors text-white placeholder-slate-500"
                />
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setStep(1)}
                className="flex-1 px-8 py-4 bg-slate-700 hover:bg-slate-600 rounded-xl transition-all font-semibold"
              >
                Back
              </button>
              <button
                onClick={handleComplete}
                disabled={!email.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-8 py-4 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 rounded-xl transition-all font-semibold shadow-lg hover:shadow-xl transform hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
              >
                <Check size={20} />
                Complete Setup
              </button>
            </div>

            <p className="text-center text-slate-500 text-sm mt-6">
              You can change these settings anytime in Configuration
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
