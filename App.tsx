
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { 
  OverlayState, 
  TranscriptionLog, 
  ConnectionStatus, 
  SermonNote, 
  BibleVerse 
} from './types';
import { fetchVerse } from './services/bibleService';
import BroadcastOverlay from './components/BroadcastOverlay';
import AudioVisualizer from './components/AudioVisualizer';

// Helper for base64 encoding/decoding
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const triggerScriptureFunction: FunctionDeclaration = {
  name: 'triggerScripture',
  parameters: {
    type: Type.OBJECT,
    description: 'Trigger a Bible verse overlay when the speaker references a specific passage.',
    properties: {
      reference: {
        type: Type.STRING,
        description: 'The Bible reference (e.g., "John 3:16", "Psalm 23").',
      },
    },
    required: ['reference'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [logs, setLogs] = useState<TranscriptionLog[]>([]);
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none', data: null, visible: false });
  const [notes] = useState<SermonNote[]>([
    { id: '1', keyword: 'faith', title: 'The Power of Faith', content: 'Faith is being sure of what we hope for and certain of what we do not see.' },
    { id: '2', keyword: 'grace', title: 'Unmerited Favor', content: 'Grace is the unmerited favor of God, as manifested in the salvation of sinners.' },
    { id: '3', keyword: 'love', title: 'The Greatest Commandment', content: 'Love the Lord your God with all your heart and with all your soul and with all your mind.' }
  ]);
  const [currentText, setCurrentText] = useState('');
  const [bibleVersion, setBibleVersion] = useState('kjv');
  const [isOverlayView, setIsOverlayView] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const syncChannel = useRef<BroadcastChannel | null>(null);

  // Check for Overlay View parameter and setup Sync Channel
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'overlay') {
      setIsOverlayView(true);
      document.body.style.backgroundColor = 'transparent';
    }

    // Initialize sync channel to communicate between Dashboard and OBS Browser Source
    syncChannel.current = new BroadcastChannel('ecclesiacast_sync');
    syncChannel.current.onmessage = (event) => {
      if (event.data.type === 'UPDATE_OVERLAY') {
        setOverlay(event.data.payload);
      }
    };

    return () => syncChannel.current?.close();
  }, []);

  // Wrap setOverlay to sync across tabs
  const updateOverlay = (newState: OverlayState) => {
    setOverlay(newState);
    syncChannel.current?.postMessage({ type: 'UPDATE_OVERLAY', payload: newState });
  };

  const startBroadcast = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are an AI Broadcast Assistant. Call 'triggerScripture' when a Bible verse is mentioned.`,
          tools: [{ functionDeclarations: [triggerScriptureFunction] }],
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            
            // Setup Visualizer Analyser
            const analyserNode = audioContextRef.current!.createAnalyser();
            analyserNode.fftSize = 256;
            source.connect(analyserNode);
            setAnalyser(analyserNode);

            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setCurrentText(prev => (prev + ' ' + text).slice(-200));
              notes.forEach(note => {
                if (text.toLowerCase().includes(note.keyword.toLowerCase())) displayNote(note);
              });
            }
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'triggerScripture') {
                  displayScripture(fc.args.reference as string);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                  }));
                }
              }
            }
          },
          onerror: () => setStatus(ConnectionStatus.ERROR),
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            setAnalyser(null);
          },
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const stopBroadcast = () => {
    sessionRef.current?.close();
    audioContextRef.current?.close();
    setStatus(ConnectionStatus.DISCONNECTED);
    setAnalyser(null);
  };

  const displayScripture = async (reference: string) => {
    const verseData = await fetchVerse(reference, bibleVersion);
    if (verseData) {
      updateOverlay({ type: 'scripture', data: verseData, visible: true });
      setLogs(prev => [{ timestamp: new Date(), text: `Detected: ${reference}`, detectedRef: reference }, ...prev].slice(0, 10));
      setTimeout(() => updateOverlay({ type: 'none', data: null, visible: false }), 15000);
    }
  };

  const displayNote = (note: SermonNote) => {
    updateOverlay({ type: 'note', data: note, visible: true });
    setLogs(prev => [{ timestamp: new Date(), text: `Note Triggered: ${note.keyword}` }, ...prev].slice(0, 10));
    setTimeout(() => updateOverlay({ type: 'none', data: null, visible: false }), 10000);
  };

  const copyOBSLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'overlay');
    navigator.clipboard.writeText(url.toString());
    alert("OBS Link copied to clipboard!");
  };

  // Render ONLY the overlay if in Overlay mode
  if (isOverlayView) {
    return <BroadcastOverlay state={overlay} onClose={() => updateOverlay({ ...overlay, visible: false })} />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="glass-morphism h-16 flex items-center justify-between px-6 sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg"><i className="fas fa-cross text-white"></i></div>
          <h1 className="text-xl font-bold tracking-tight">EcclesiaCast <span className="text-indigo-400">AI</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={copyOBSLink} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg transition-colors border border-slate-700 flex items-center gap-2">
            <i className="fas fa-link"></i> Copy OBS URL
          </button>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-xs">
            <span className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
            {status}
          </div>
          {status === ConnectionStatus.CONNECTED ? (
            <button onClick={stopBroadcast} className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-all">Stop</button>
          ) : (
            <button onClick={startBroadcast} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium transition-all">Start Broadcast</button>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 overflow-hidden">
        <div className="lg:col-span-8 flex flex-col gap-6">
          <div className="glass-morphism rounded-xl p-6 flex-1 flex flex-col min-h-[300px]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <i className="fas fa-wave-square text-indigo-400"></i> Live Transcription
              </h2>
              {/* Audio Wave Visualizer Integration */}
              <div className="w-48 bg-slate-900/40 rounded-lg overflow-hidden border border-slate-700/50">
                <AudioVisualizer analyser={analyser} isActive={status === ConnectionStatus.CONNECTED} />
              </div>
            </div>
            <div className="flex-1 bg-slate-900/50 rounded-lg p-4 font-serif text-xl leading-relaxed text-slate-300 overflow-y-auto">
              {currentText || "Start broadcast to listen..."}
            </div>
          </div>
          <div className="glass-morphism rounded-xl p-6 h-64 overflow-hidden flex flex-col">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-list-check text-indigo-400"></i> Keyword Triggers
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 overflow-y-auto">
              {notes.map(note => (
                <button key={note.id} onClick={() => displayNote(note)} className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 hover:border-indigo-500 text-left transition-all group">
                  <div className="font-bold text-xs text-indigo-300 uppercase tracking-tighter group-hover:text-white transition-colors">{note.keyword}</div>
                  <div className="text-xs text-slate-400 mt-1 truncate">{note.title}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col gap-6">
          <div className="glass-morphism rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-search text-indigo-400"></i> Quick Display
            </h2>
            <div className="flex flex-col gap-4">
              <input 
                type="text" placeholder="Search Verse..."
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-indigo-500 outline-none text-white"
                onKeyDown={(e) => e.key === 'Enter' && displayScripture(e.currentTarget.value)}
              />
              <select value={bibleVersion} onChange={(e) => setBibleVersion(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-white">
                <option value="kjv">KJV</option>
                <option value="niv">NIV</option>
                <option value="esv">ESV</option>
              </select>
            </div>
          </div>
          <div className="glass-morphism rounded-xl p-6 flex-1 flex flex-col overflow-hidden">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-history text-indigo-400"></i> Broadcast Log
            </h2>
            <div className="flex-1 overflow-y-auto space-y-3">
              {logs.length === 0 ? (
                <div className="text-center text-slate-600 italic text-xs py-8">No activities detected</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="text-xs p-2 bg-slate-800/30 rounded border-l-2 border-indigo-500 flex justify-between animate-fade-in">
                    <span>{log.text}</span>
                    <span className="text-[9px] text-slate-500">{log.timestamp.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Local Preview of Overlay */}
      <div className="fixed bottom-4 left-4 p-2 bg-slate-800/80 backdrop-blur text-[10px] rounded border border-slate-700 text-slate-400 z-30">
        <i className="fas fa-info-circle mr-1 text-indigo-400"></i> Dashboard Control Mode
      </div>
      <BroadcastOverlay state={overlay} onClose={() => updateOverlay({ ...overlay, visible: false })} />
    </div>
  );
};

export default App;
