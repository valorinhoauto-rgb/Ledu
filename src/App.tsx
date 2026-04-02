import { useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  BookOpen, 
  ClipboardCheck, 
  Search, 
  ChevronRight, 
  ArrowLeft, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  Upload,
  Trophy,
  RefreshCcw,
  HelpCircle,
  FileText,
  File as FileIcon,
  Camera,
  X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { geminiService, type QuizQuestion, type StudyTopic } from "./services/geminiService";
import { cn } from "./lib/utils";

type AppState = "HOME" | "CHOICE" | "STUDY" | "QUIZ_SETUP" | "QUIZ" | "RESULTS";

export default function App() {
  const [state, setState] = useState<AppState>("HOME");
  const [subject, setSubject] = useState("");
  const [loading, setLoading] = useState(false);
  
  // Study Data
  const [topics, setTopics] = useState<StudyTopic[]>([]);
  
  // Quiz Data
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, number>>({});
  const [numQuestions, setNumQuestions] = useState(5);
  const [uploadText, setUploadText] = useState("");
  const [uploadMethod, setUploadMethod] = useState<"TEXT" | "FILE">("TEXT");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setSelectedFiles(prev => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(",")[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleStart = () => {
    if (subject.trim()) {
      setState("CHOICE");
    }
  };

  const startStudy = async () => {
    setLoading(true);
    const data = await geminiService.getStudyTopics(subject);
    setTopics(data);
    setLoading(false);
    setState("STUDY");
  };

  const startQuiz = async (fromUpload = false) => {
    setLoading(true);
    let data: QuizQuestion[] = [];
    try {
      if (fromUpload) {
        if (uploadMethod === "TEXT") {
          data = await geminiService.generateQuizFromText(uploadText);
        } else if (selectedFiles.length > 0) {
          const mediaItems = await Promise.all(selectedFiles.map(async (file) => ({
            base64Data: await fileToBase64(file),
            mimeType: file.type
          })));
          data = await geminiService.generateQuizFromMedia(mediaItems);
        }
      } else {
        data = await geminiService.generateQuiz(subject, numQuestions);
      }
      setQuestions(data);
      setCurrentQuestionIndex(0);
      setUserAnswers({});
      setLoading(false);
      setState("QUIZ");
    } catch (error) {
      console.error("Erro ao iniciar simulado:", error);
      setLoading(false);
    }
  };

  const handleAnswer = (optionIndex: number) => {
    setUserAnswers(prev => ({ ...prev, [currentQuestionIndex]: optionIndex }));
  };

  const nextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else {
      setState("RESULTS");
    }
  };

  const calculateScore = () => {
    let correct = 0;
    questions.forEach((q, idx) => {
      if (userAnswers[idx] === q.correctAnswer) {
        correct++;
      }
    });
    return {
      correct,
      total: questions.length,
      percentage: Math.round((correct / questions.length) * 100)
    };
  };

  const reset = () => {
    setState("HOME");
    setSubject("");
    setTopics([]);
    setQuestions([]);
    setUserAnswers({});
    setUploadText("");
    setSelectedFiles([]);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans selection:bg-indigo-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-4">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div 
              className="flex items-center gap-2 cursor-pointer group"
              onClick={reset}
            >
              <div className="bg-indigo-600 p-2 rounded-xl group-hover:scale-110 transition-transform">
                <BookOpen className="text-white w-5 h-5" />
              </div>
              <h1 className="text-xl font-bold text-slate-800">Ledu</h1>
            </div>
            
            <div className="flex items-center gap-4">
              {state !== "HOME" && (
                <button 
                  onClick={reset}
                  className="text-sm font-medium text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors"
                >
                  <RefreshCcw className="w-4 h-4" />
                  Recomeçar
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {/* HOME STATE */}
          {state === "HOME" && (
            <motion.div 
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center space-y-8"
            >
              <div className="space-y-4">
                <h2 className="text-4xl md:text-5xl font-extrabold text-slate-900">
                  O que vamos aprender <span className="text-indigo-600">hoje?</span>
                </h2>
                <p className="text-slate-500 text-lg max-w-xl mx-auto">
                  Transforme qualquer assunto em uma jornada de aprendizado personalizada com a inteligência do Gemini.
                </p>
              </div>

              <div className="max-w-lg mx-auto relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Search className="text-slate-400 w-5 h-5" />
                </div>
                <input 
                  type="text"
                  placeholder="Ex: Revolução Francesa, Fotossíntese, JavaScript..."
                  className="w-full pl-12 pr-4 py-4 bg-white border-2 border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 outline-none transition-all text-lg shadow-sm"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                />
                <button 
                  onClick={handleStart}
                  disabled={!subject.trim()}
                  className="mt-6 w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-bold py-4 rounded-2xl shadow-lg shadow-indigo-200 transition-all flex items-center justify-center gap-2 group"
                >
                  Começar Jornada
                  <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </motion.div>
          )}

          {/* CHOICE STATE */}
          {state === "CHOICE" && (
            <motion.div 
              key="choice"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-8"
            >
              <div className="text-center space-y-2">
                <span className="text-indigo-600 font-semibold uppercase tracking-wider text-sm">Tema: {subject}</span>
                <h2 className="text-3xl font-bold text-slate-900">Como você prefere seguir?</h2>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <button 
                  onClick={startStudy}
                  className="group p-8 bg-white border-2 border-slate-100 hover:border-indigo-500 rounded-3xl text-left transition-all hover:shadow-xl hover:-translate-y-1"
                >
                  <div className="bg-indigo-50 p-4 rounded-2xl w-fit mb-6 group-hover:bg-indigo-600 transition-colors">
                    <BookOpen className="text-indigo-600 w-8 h-8 group-hover:text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">Quero Estudar</h3>
                  <p className="text-slate-500">O Gemini vai preparar um guia de estudos completo com os tópicos mais importantes de forma clara.</p>
                </button>

                <button 
                  onClick={() => setState("QUIZ_SETUP")}
                  className="group p-8 bg-white border-2 border-slate-100 hover:border-emerald-500 rounded-3xl text-left transition-all hover:shadow-xl hover:-translate-y-1"
                >
                  <div className="bg-emerald-50 p-4 rounded-2xl w-fit mb-6 group-hover:bg-emerald-600 transition-colors">
                    <ClipboardCheck className="text-emerald-600 w-8 h-8 group-hover:text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">Fazer Simulado</h3>
                  <p className="text-slate-500">Teste seus conhecimentos com questões personalizadas ou suba suas próprias perguntas.</p>
                </button>
              </div>

              <button 
                onClick={() => setState("HOME")}
                className="mx-auto flex items-center gap-2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar
              </button>
            </motion.div>
          )}

          {/* STUDY STATE */}
          {state === "STUDY" && (
            <motion.div 
              key="study"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold text-slate-900">{subject}</h2>
                  <p className="text-slate-500">Guia de estudos preparado pela IA</p>
                </div>
                <button 
                  onClick={() => setState("CHOICE")}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <ArrowLeft className="w-6 h-6 text-slate-600" />
                </button>
              </div>

              <div className="space-y-6">
                {topics.map((topic, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm"
                  >
                    <h3 className="text-xl font-bold text-indigo-600 mb-4 flex items-center gap-2">
                      <span className="bg-indigo-100 text-indigo-700 w-8 h-8 rounded-lg flex items-center justify-center text-sm">{idx + 1}</span>
                      {topic.title}
                    </h3>
                    <div className="prose prose-slate max-w-none prose-headings:text-slate-800 prose-p:text-slate-600">
                      <ReactMarkdown>{topic.content}</ReactMarkdown>
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="flex justify-center pt-8">
                <button 
                  onClick={() => setState("QUIZ_SETUP")}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-emerald-100 transition-all flex items-center gap-2"
                >
                  <ClipboardCheck className="w-5 h-5" />
                  Pronto para um simulado?
                </button>
              </div>
            </motion.div>
          )}

          {/* QUIZ SETUP STATE */}
          {state === "QUIZ_SETUP" && (
            <motion.div 
              key="quiz_setup"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-2xl mx-auto space-y-8"
            >
              <div className="text-center space-y-2">
                <h2 className="text-3xl font-bold text-slate-900">Configurar Simulado</h2>
                <p className="text-slate-500">Escolha como quer que o Gemini monte suas questões.</p>
              </div>

              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm space-y-8">
                <div className="space-y-4">
                  <label className="block font-bold text-slate-700">Quantas questões você deseja?</label>
                  <div className="flex gap-4">
                    {[5, 10, 15, 20].map(n => (
                      <button 
                        key={n}
                        onClick={() => setNumQuestions(n)}
                        className={cn(
                          "flex-1 py-3 rounded-xl font-bold transition-all border-2",
                          numQuestions === n 
                            ? "bg-indigo-600 border-indigo-600 text-white shadow-md" 
                            : "bg-white border-slate-100 text-slate-600 hover:border-indigo-200"
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <button 
                    onClick={() => startQuiz(false)}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-indigo-100"
                  >
                    Gerar Simulado Automaticamente
                  </button>
                </div>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-100"></div>
                  </div>
                  <div className="relative flex justify-center text-sm uppercase">
                    <span className="bg-white px-4 text-slate-400 font-medium">Ou use suas próprias questões</span>
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="block font-bold text-slate-700 flex items-center gap-2">
                    Como deseja fornecer as questões?
                  </label>
                  <div className="flex gap-4">
                    <button 
                      onClick={() => setUploadMethod("TEXT")}
                      className={cn(
                        "flex-1 py-3 rounded-xl font-bold transition-all border-2 flex items-center justify-center gap-2",
                        uploadMethod === "TEXT" 
                          ? "bg-indigo-50 border-indigo-600 text-indigo-900" 
                          : "bg-white border-slate-100 text-slate-600 hover:border-indigo-200"
                      )}
                    >
                      <FileText className="w-4 h-4" /> Texto
                    </button>
                    <button 
                      onClick={() => setUploadMethod("FILE")}
                      className={cn(
                        "flex-1 py-3 rounded-xl font-bold transition-all border-2 flex items-center justify-center gap-2",
                        uploadMethod === "FILE" 
                          ? "bg-indigo-50 border-indigo-600 text-indigo-900" 
                          : "bg-white border-slate-100 text-slate-600 hover:border-indigo-200"
                      )}
                    >
                      <FileIcon className="w-4 h-4" /> PDF / Foto
                    </button>
                  </div>

                  {uploadMethod === "TEXT" ? (
                    <div className="space-y-4">
                      <textarea 
                        placeholder="Cole aqui o texto das questões que você acredita que cairão na prova ou o conteúdo que quer que seja transformado em simulado..."
                        className="w-full h-40 p-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"
                        value={uploadText}
                        onChange={(e) => setUploadText(e.target.value)}
                      />
                      <button 
                        onClick={() => startQuiz(true)}
                        disabled={!uploadText.trim()}
                        className="w-full bg-white border-2 border-slate-200 hover:border-indigo-500 text-slate-700 hover:text-indigo-600 font-bold py-4 rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Montar Simulado com meu Texto
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <input 
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept="application/pdf,image/*"
                        multiple
                        className="hidden"
                      />
                      
                      <div className="grid grid-cols-2 gap-4">
                        <button 
                          onClick={() => {
                            if (fileInputRef.current) {
                              fileInputRef.current.accept = "application/pdf";
                              fileInputRef.current.click();
                            }
                          }}
                          className="p-6 bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl hover:border-indigo-500 hover:bg-indigo-50 transition-all flex flex-col items-center gap-3 group"
                        >
                          <FileIcon className="w-6 h-6 text-slate-400 group-hover:text-indigo-600" />
                          <span className="text-xs font-bold text-slate-500 group-hover:text-indigo-700">Adicionar PDF</span>
                        </button>
                        <button 
                          onClick={() => {
                            if (fileInputRef.current) {
                              fileInputRef.current.accept = "image/*";
                              fileInputRef.current.click();
                            }
                          }}
                          className="p-6 bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl hover:border-indigo-500 hover:bg-indigo-50 transition-all flex flex-col items-center gap-3 group"
                        >
                          <Camera className="w-6 h-6 text-slate-400 group-hover:text-indigo-600" />
                          <span className="text-xs font-bold text-slate-500 group-hover:text-indigo-700">Tirar Foto / Galeria</span>
                        </button>
                      </div>

                      {selectedFiles.length > 0 && (
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                          {selectedFiles.map((file, idx) => (
                            <div key={idx} className="p-3 bg-indigo-50 border border-indigo-100 rounded-xl flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {file.type.includes("pdf") ? <FileIcon className="w-4 h-4 text-indigo-600" /> : <Camera className="w-4 h-4 text-indigo-600" />}
                                <div className="min-w-0">
                                  <p className="font-bold text-indigo-900 text-xs truncate max-w-[150px]">{file.name}</p>
                                  <p className="text-[10px] text-indigo-700">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                </div>
                              </div>
                              <button 
                                onClick={() => removeFile(idx)}
                                className="p-1.5 hover:bg-indigo-100 rounded-full transition-colors"
                              >
                                <X className="w-4 h-4 text-indigo-600" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      <button 
                        onClick={() => startQuiz(true)}
                        disabled={selectedFiles.length === 0}
                        className="w-full bg-white border-2 border-slate-200 hover:border-indigo-500 text-slate-700 hover:text-indigo-600 font-bold py-4 rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Montar Simulado com {selectedFiles.length} {selectedFiles.length === 1 ? "Arquivo" : "Arquivos"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <button 
                onClick={() => setState("CHOICE")}
                className="mx-auto flex items-center gap-2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar
              </button>
            </motion.div>
          )}

          {/* QUIZ STATE */}
          {state === "QUIZ" && questions.length > 0 && (
            <motion.div 
              key="quiz"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h2 className="text-sm font-bold text-indigo-600 uppercase tracking-widest">Questão {currentQuestionIndex + 1} de {questions.length}</h2>
                  <div className="w-64 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-indigo-600"
                      initial={{ width: 0 }}
                      animate={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-slate-400 font-medium">{subject}</div>
              </div>

              <div className="bg-white p-8 md:p-12 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-8">
                <h3 className="text-2xl font-bold text-slate-800 leading-tight">
                  {questions[currentQuestionIndex].question}
                </h3>

                <div className="space-y-4">
                  {questions[currentQuestionIndex].options.map((option, idx) => (
                    <button 
                      key={idx}
                      onClick={() => handleAnswer(idx)}
                      className={cn(
                        "w-full p-6 rounded-2xl text-left transition-all border-2 flex items-center gap-4 group",
                        userAnswers[currentQuestionIndex] === idx 
                          ? "bg-indigo-50 border-indigo-600 text-indigo-900" 
                          : "bg-white border-slate-100 hover:border-indigo-200 text-slate-600"
                      )}
                    >
                      <span className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm transition-colors",
                        userAnswers[currentQuestionIndex] === idx 
                          ? "bg-indigo-600 text-white" 
                          : "bg-slate-100 text-slate-500 group-hover:bg-indigo-100"
                      )}>
                        {String.fromCharCode(65 + idx)}
                      </span>
                      <span className="font-medium">{option}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <button 
                  onClick={nextQuestion}
                  disabled={userAnswers[currentQuestionIndex] === undefined}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white font-bold px-10 py-4 rounded-2xl shadow-lg shadow-indigo-100 transition-all flex items-center gap-2 group"
                >
                  {currentQuestionIndex === questions.length - 1 ? "Finalizar" : "Próxima"}
                  <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </motion.div>
          )}

          {/* RESULTS STATE */}
          {state === "RESULTS" && (
            <motion.div 
              key="results"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-12"
            >
              <div className="text-center space-y-6">
                <div className="inline-block p-6 bg-indigo-50 rounded-full mb-4">
                  <Trophy className="w-16 h-16 text-indigo-600" />
                </div>
                <h2 className="text-4xl font-extrabold text-slate-900">Simulado Concluído!</h2>
                <div className="flex justify-center gap-8">
                  <div className="text-center">
                    <div className="text-4xl font-black text-indigo-600">{calculateScore().correct}/{calculateScore().total}</div>
                    <div className="text-slate-500 font-medium">Acertos</div>
                  </div>
                  <div className="text-center border-l border-slate-200 pl-8">
                    <div className="text-4xl font-black text-indigo-600">{calculateScore().percentage}%</div>
                    <div className="text-slate-500 font-medium">Desempenho</div>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                  <HelpCircle className="w-5 h-5 text-indigo-600" />
                  Revisão Detalhada
                </h3>
                {questions.map((q, idx) => {
                  const isCorrect = userAnswers[idx] === q.correctAnswer;
                  return (
                    <div key={idx} className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
                      <div className={cn(
                        "px-6 py-3 flex items-center justify-between",
                        isCorrect ? "bg-emerald-50" : "bg-rose-50"
                      )}>
                        <span className={cn(
                          "font-bold text-sm uppercase tracking-wider",
                          isCorrect ? "text-emerald-700" : "text-rose-700"
                        )}>
                          Questão {idx + 1}
                        </span>
                        {isCorrect ? (
                          <div className="flex items-center gap-1 text-emerald-700 font-bold text-sm">
                            <CheckCircle2 className="w-4 h-4" /> Correto
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-rose-700 font-bold text-sm">
                            <XCircle className="w-4 h-4" /> Incorreto
                          </div>
                        )}
                      </div>
                      <div className="p-8 space-y-6">
                        <p className="font-bold text-slate-800 text-lg">{q.question}</p>
                        
                        <div className="space-y-3">
                          {q.options.map((opt, optIdx) => {
                            const isUserChoice = userAnswers[idx] === optIdx;
                            const isCorrectAnswer = q.correctAnswer === optIdx;
                            
                            return (
                              <div 
                                key={optIdx}
                                className={cn(
                                  "p-4 rounded-xl border flex items-center gap-3",
                                  isCorrectAnswer ? "bg-emerald-50 border-emerald-200 text-emerald-900" : 
                                  isUserChoice ? "bg-rose-50 border-rose-200 text-rose-900" : "bg-slate-50 border-transparent text-slate-500"
                                )}
                              >
                                {isCorrectAnswer && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                                {!isCorrectAnswer && isUserChoice && <XCircle className="w-4 h-4 shrink-0" />}
                                <span className="font-medium">{opt}</span>
                              </div>
                            );
                          })}
                        </div>

                        <div className="bg-indigo-50 p-6 rounded-2xl space-y-2">
                          <h4 className="font-bold text-indigo-900 flex items-center gap-2">
                            <HelpCircle className="w-4 h-4" /> Explicação
                          </h4>
                          <p className="text-indigo-800/80 text-sm leading-relaxed">{q.explanation}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col sm:flex-row justify-center gap-4 pt-8">
                <button 
                  onClick={() => setState("QUIZ_SETUP")}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-indigo-100 transition-all flex items-center justify-center gap-2"
                >
                  <RefreshCcw className="w-5 h-5" /> Tentar Novamente
                </button>
                <button 
                  onClick={reset}
                  className="bg-white border-2 border-slate-200 hover:border-slate-300 text-slate-600 font-bold px-8 py-4 rounded-2xl transition-all flex items-center justify-center gap-2"
                >
                  Novo Tema
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Loading Overlay */}
      <AnimatePresence>
        {loading && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="relative">
              <Loader2 className="w-16 h-16 text-indigo-600 animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-2 h-2 bg-indigo-600 rounded-full animate-ping" />
              </div>
            </div>
            <h3 className="mt-8 text-2xl font-bold text-slate-900">O Gemini está preparando tudo...</h3>
            <p className="mt-2 text-slate-500 max-w-xs">Organizando tópicos e criando questões exclusivas para você.</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="py-12 text-center text-slate-400 text-sm">
        <p>© 2026 Ledu • Potencializado por Inteligência Artificial</p>
      </footer>
    </div>
  );
}
