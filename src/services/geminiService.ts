import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../lib/firebase";

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]/g, ""); // remove non-alphanumeric characters
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

// Função para obter a chave de forma dinâmica
export const getApiKey = () => {
  // 1. Tenta pegar da variável de ambiente do Vite (Recomendado para Netlify/Vercel)
  // No Netlify, configure como VITE_GEMINI_API_KEY ou GEMINI_API_KEY
  const viteKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (viteKey && typeof viteKey === 'string' && viteKey.trim() !== '') return viteKey.trim();

  // 2. Fallback para process.env (Injetado pelo Vite via define no vite.config.ts)
  // Útil para o ambiente do AI Studio e builds do Netlify
  try {
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey && typeof envKey === 'string' && envKey.trim() !== '') return envKey.trim();
  } catch (e) {
    // process.env pode não estar definido no browser
  }

  // 3. Tenta pegar do localStorage
  if (typeof window !== 'undefined') {
    const localKey = localStorage.getItem("LEMA_API_KEY") || localStorage.getItem("GEMINI_API_KEY");
    if (localKey && typeof localKey === 'string' && localKey.trim() !== '') return localKey.trim();
  }

  return "";
};

// Criamos uma função que retorna a instância do AI sempre atualizada
const getAI = () => {
  const key = getApiKey();
  if (!key) {
    throw new Error("API_KEY_MISSING: Chave da API Gemini não encontrada. Configure VITE_GEMINI_API_KEY nas variáveis de ambiente do Netlify.");
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
};

export interface StudyTopic {
  title: string;
  content: string;
}

export interface Assignment {
  title: string;
  introduction: string;
  sections: { title: string; content: string }[];
  conclusion: string;
  references: string[];
}

// Função auxiliar para lidar com retentativas em caso de erro de cota (429) ou instabilidade (503/500)
const withRetry = async <T>(fn: () => Promise<T>, maxRetries = 4, delay = 3000): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || "";
      const isRetryable = 
        errorMessage.includes("429") || 
        errorMessage.includes("Quota exceeded") ||
        errorMessage.includes("500") ||
        errorMessage.includes("503") ||
        errorMessage.includes("rate limit");
      
      if (isRetryable && i < maxRetries - 1) {
        console.warn(`Tentativa ${i + 1} falhou devido a limite de cota. Tentando novamente em ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

export type QuestionType = "MULTIPLE_CHOICE" | "OPEN_ENDED";

export interface QuizQuestion {
  id: number;
  type: QuestionType;
  question: string;
  options?: string[]; // Only for MULTIPLE_CHOICE
  correctAnswer?: number; // Only for MULTIPLE_CHOICE (0-based index)
  correctOptionLetter?: string; // "A" | "B" | "C" | "D" | "E" | "N/A"
  explanation: string;
  suggestedAnswer?: string; // For OPEN_ENDED
}

export interface EvaluationResult {
  score: number; // 0 to 100
  feedback: string;
}

const PORTUGUESE_STOPWORDS = new Set([
  "para", "como", "mais", "pela", "pelo", "pelos", "pelas", "deve", "devem",
  "sobre", "entre", "quando", "onde", "qual", "quais", "porque", "pois",
  "isso", "esta", "este", "essa", "esse", "suas", "seus", "toda", "todo",
  "todos", "todas", "pode", "podem", "apenas", "somente", "uma", "uns",
  "umas", "com", "sem", "dos", "das", "nos", "nas", "aos", "que", "por",
  "ser", "sao", "foi", "era", "ter", "tem", "nao", "sim", "alternativa",
  "correta", "opcao", "resposta", "letra", "gabarito", "indica", "afirma"
]);

function cleanOptionPrefix(opt: string): string {
  if (!opt || typeof opt !== "string") return "";
  return opt.replace(/^\s*(?:\([A-Ea-e1-5]\)|[A-Ea-e1-5][\)\.\-:])\s+/, "").trim();
}

function extractExplicitAnswerLetterIndex(explanation: string, optionsCount: number): number | null {
  if (!explanation || optionsCount <= 0) return null;

  // Match explicit uppercase letter or "letra X" / "(X)" / ": x." patterns to avoid matching Portuguese articles "a" or "e"
  const patterns: RegExp[] = [
    /(?:alternativa|op[çc][ãa]o|resposta|item)\s+corret[ao]\s*(?:[ée]\s*(?:a\s+|o\s+)?(?:letra\s+|alternativa\s+|op[çc][ãa]o\s+)?|:\s*|\-\s*)\(?([A-E])\b\)?/,
    /(?:alternativa|op[çc][ãa]o|resposta|item)\s+corret[ao]\s*(?:[ée]\s*(?:a\s+|o\s+)?|:\s*|\-\s*)(?:letra\s+\(?([A-Ea-e])\)?|\(([A-Ea-e])\)|([A-Ea-e])[\.\)])/i,
    /gabarito\s*(?:oficial\s*)?(?:[ée]\s*(?:a\s+|o\s+)?(?:letra\s+|alternativa\s+)?|:\s*|\-\s*)\(?([A-E])\b\)?/,
    /gabarito\s*(?:oficial\s*)?(?:[ée]\s*(?:a\s+|o\s+)?|:\s*|\-\s*)(?:letra\s+\(?([A-Ea-e])\)?|\(([A-Ea-e])\)|([A-Ea-e])[\.\)])/i,
    /\bletra\s+\(?([A-Ea-e])\)?\s+(?:[ée]\s+a\s+correta|est[áa]\s+correta|corresponde\s+[àa]\s+resposta\s+correta)/i,
    /\b(?:alternativa|op[çc][ãa]o)\s+\(?([A-E])\)?\s+(?:[ée]\s+a\s+correta|est[áa]\s+correta)/,
    /^\s*(?:alternativa\s+correta|resposta\s+correta|gabarito)\s*[:\-]\s*\(?([A-Ea-e])\)?(?=[\.\)\:\-\s]|$)/i,
  ];

  for (const regex of patterns) {
    const match = explanation.match(regex);
    if (match) {
      const letter = (match[1] || match[2] || match[3] || "").toUpperCase();
      if (letter >= "A" && letter <= "E") {
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < optionsCount) {
          return idx;
        }
      }
    }
  }

  return null;
}

function getSignificantWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !PORTUGUESE_STOPWORDS.has(w));
}

function findBestOptionIndexByExplanationText(
  explanation: string,
  options: string[]
): { index: number; score: number; runnerUpScore: number } | null {
  if (!explanation || options.length === 0) return null;

  const normExp = explanation
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const expWords = new Set(getSignificantWords(explanation));
  if (expWords.size === 0 && normExp.length < 10) return null;

  const scores = options.map((opt, index) => {
    const normOpt = opt
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (normOpt.length >= 16 && normExp.includes(normOpt)) {
      return { index, score: 1.0 };
    }

    const optWords = getSignificantWords(opt);
    if (optWords.length === 0) {
      return { index, score: 0 };
    }

    let matched = 0;
    for (const w of optWords) {
      if (expWords.has(w)) matched++;
    }

    const ratio = matched / optWords.length;
    // Slight bonus when option has more matched significant words
    const weightedScore = optWords.length >= 2 ? ratio : ratio * 0.6;
    return { index, score: weightedScore };
  });

  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const runnerUp = sorted[1] || { index: -1, score: 0 };

  return {
    index: best.index,
    score: best.score,
    runnerUpScore: runnerUp.score,
  };
}

function resolveMultipleChoiceQuestion(q: QuizQuestion): QuizQuestion {
  if (q.type !== "MULTIPLE_CHOICE" || !Array.isArray(q.options) || q.options.length === 0) {
    return q;
  }

  const cleanedOptions = q.options.map(cleanOptionPrefix);
  const optionsCount = cleanedOptions.length;
  const explanation = (q.explanation || "").trim();

  const explanationLetterIndex = extractExplicitAnswerLetterIndex(explanation, optionsCount);

  let schemaLetterIndex: number | null = null;
  if (q.correctOptionLetter && typeof q.correctOptionLetter === "string") {
    const cleanLetter = q.correctOptionLetter.trim().toUpperCase().replace(/[^A-E]/g, "");
    if (cleanLetter.length === 1) {
      const idx = cleanLetter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < optionsCount) {
        schemaLetterIndex = idx;
      }
    }
  }

  const textMatch = findBestOptionIndexByExplanationText(explanation, cleanedOptions);

  let resolvedIndex: number | null = null;

  // 1. Highest priority: explicit letter declared in explanation (e.g., "Alternativa correta: C.")
  if (explanationLetterIndex !== null) {
    resolvedIndex = explanationLetterIndex;
  }
  // 2. Next priority: explicit correctOptionLetter field from structured output ("A".."E")
  else if (schemaLetterIndex !== null) {
    if (
      textMatch &&
      textMatch.index !== schemaLetterIndex &&
      textMatch.score >= 0.8 &&
      textMatch.runnerUpScore <= 0.2
    ) {
      resolvedIndex = textMatch.index;
    } else {
      resolvedIndex = schemaLetterIndex;
    }
  }
  // 3. Next priority: numeric correctAnswer with 1-based off-by-one detection via explanation text match
  else if (typeof q.correctAnswer === "number" && Number.isInteger(q.correctAnswer)) {
    if (q.correctAnswer >= 0 && q.correctAnswer < optionsCount) {
      if (
        q.correctAnswer >= 1 &&
        textMatch &&
        textMatch.index === q.correctAnswer - 1 &&
        textMatch.score >= 0.65 &&
        textMatch.runnerUpScore <= 0.25
      ) {
        resolvedIndex = q.correctAnswer - 1;
      } else {
        resolvedIndex = q.correctAnswer;
      }
    } else if (q.correctAnswer === optionsCount) {
      // Model returned 1-based index for the last option (e.g., 4 for 4 options or 5 for 5 options)
      resolvedIndex =
        textMatch && textMatch.score >= 0.5 && textMatch.score > textMatch.runnerUpScore
          ? textMatch.index
          : optionsCount - 1;
    }
  }

  // 4. Fallback: match explanation text against option texts
  if (resolvedIndex === null) {
    if (textMatch && textMatch.score >= 0.35 && textMatch.score > textMatch.runnerUpScore) {
      resolvedIndex = textMatch.index;
    } else {
      resolvedIndex = 0;
    }
  }

  const resolvedLetter = String.fromCharCode(65 + resolvedIndex);

  return {
    ...q,
    options: cleanedOptions,
    correctAnswer: resolvedIndex,
    correctOptionLetter: resolvedLetter,
  };
}

async function processAndSyncQuizQuestions(questions: QuizQuestion[]): Promise<QuizQuestion[]> {
  const processedQuestions: QuizQuestion[] = [];

  for (let i = 0; i < questions.length; i++) {
    const rawQuestion = questions[i];
    const q = resolveMultipleChoiceQuestion({
      ...rawQuestion,
      id: i + 1,
    });

    if (!q.question) {
      processedQuestions.push(q);
      continue;
    }

    const normalized = normalizeText(q.question);
    const docId = normalized.slice(0, 100) + "_" + simpleHash(normalized);
    const questionRef = doc(db, "questions_registry", docId);

    let storedData: any = null;
    try {
      const questionSnap = await getDoc(questionRef);
      if (questionSnap.exists()) {
        storedData = questionSnap.data();
      }
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.GET, `questions_registry/${docId}`);
      } catch (logErr) {
        console.error("Firestore Error Info Logged (GET):", logErr);
      }
    }

    if (storedData) {
      console.log(`[questions_registry] Encontrada questão consistente para: "${q.question.slice(0, 30)}..."`);

      const storedOptions =
        Array.isArray(storedData.options) && storedData.options.length > 0
          ? storedData.options.map(cleanOptionPrefix)
          : q.options;

      const storedExp = typeof storedData.explanation === "string" ? storedData.explanation : "";
      const storedExpHasLetter =
        storedOptions && storedOptions.length > 0
          ? extractExplicitAnswerLetterIndex(storedExp, storedOptions.length) !== null
          : false;

      const sameOptionsCount =
        Array.isArray(storedOptions) &&
        Array.isArray(q.options) &&
        storedOptions.length === q.options.length &&
        storedOptions.every((opt, idx) => normalizeText(opt) === normalizeText(q.options![idx] || ""));

      // Prefer incoming explanation if stored explanation lacked an explicit letter and options are identical
      const effectiveExplanation =
        !storedExpHasLetter && sameOptionsCount && q.explanation ? q.explanation : storedExp || q.explanation;

      const hasValidStoredAnswer =
        typeof storedData.correctAnswer === "number" &&
        Number.isInteger(storedData.correctAnswer) &&
        storedData.correctAnswer >= 0 &&
        storedData.correctAnswer < (storedOptions?.length || 5);

      const rawMerged: QuizQuestion = {
        ...q,
        id: i + 1,
        type: (storedData.type as QuestionType) || q.type,
        options: storedOptions,
        correctAnswer:
          hasValidStoredAnswer && (storedExpHasLetter || !sameOptionsCount)
            ? storedData.correctAnswer
            : q.correctAnswer ?? storedData.correctAnswer,
        correctOptionLetter:
          !storedExpHasLetter && sameOptionsCount ? q.correctOptionLetter : undefined,
        suggestedAnswer: storedData.suggestedAnswer || q.suggestedAnswer,
        explanation: effectiveExplanation,
      };

      const merged = resolveMultipleChoiceQuestion(rawMerged);
      processedQuestions.push(merged);
    } else {
      console.log(`[questions_registry] Registrando nova questão para consistência: "${q.question.slice(0, 30)}..."`);
      const docData: any = {
        question: q.question,
        type: q.type,
        explanation: q.explanation || "",
        createdAt: serverTimestamp(),
      };

      if (q.type === "MULTIPLE_CHOICE") {
        docData.options = q.options || [];
        docData.correctAnswer = typeof q.correctAnswer === "number" ? q.correctAnswer : 0;
      } else if (q.type === "OPEN_ENDED") {
        docData.suggestedAnswer = q.suggestedAnswer || "";
      }

      try {
        await setDoc(questionRef, docData);
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.WRITE, `questions_registry/${docId}`);
        } catch (logErr) {
          console.error("Firestore Error Info Logged (WRITE):", logErr);
        }
      }
      processedQuestions.push(q);
    }
  }

  return processedQuestions;
}

export const geminiService = {
  async getStudyTopics(subject: string): Promise<StudyTopic[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Você é um tutor especializado. O aluno quer estudar sobre: "${subject}". 
      Forneça uma lista de tópicos principais com explicações claras, intuitivas e didáticas.
      Retorne em formato JSON: uma lista de objetos com "title" e "content" (em markdown).`,
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              content: { type: Type.STRING },
            },
            required: ["title", "content"],
          },
        },
      },
    }));

    try {
      const parsed = JSON.parse(response.text || "[]");
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Não foi possível gerar tópicos para este assunto.");
      }
      return parsed;
    } catch (e: any) {
      console.error("Erro ao parsear tópicos de estudo", e);
      throw e;
    }
  },

  async generateQuiz(subject: string): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Gere um simulado completo sobre o tema: "${subject}".
      O simulado deve conter EXATAMENTE:
      1. 10 questões de múltipla escolha (tipo MULTIPLE_CHOICE) com 4 ou 5 opções cada.
      2. 6 questões discursivas (tipo OPEN_ENDED) para que o aluno escolha 3 para responder.
      
      REGRAS DE FORMATAÇÃO E GABARITO:
      - Use quebras de linha duplas entre parágrafos.
      - Se a questão tiver itens (ex: I, II, III ou a, b, c), use listas ou quebras de linha claras para que não fiquem amontoados.
      - Para questões MULTIPLE_CHOICE:
        * Forneça "options" (array de strings sem prefixos "A)", "B)", etc.).
        * Forneça "correctOptionLetter" com a letra exata da opção correta ("A", "B", "C", "D" ou "E").
        * Forneça "correctAnswer" com o índice BASEADO EM ZERO correspondente à letra (0 para A, 1 para B, 2 para C, 3 para D, 4 para E).
        * Comece SEMPRE o campo "explanation" com "Alternativa correta: <LETRA>." garantindo que <LETRA>, "correctOptionLetter" e "correctAnswer" apontem exatamente para a mesma alternativa.
      - Para questões OPEN_ENDED:
        * Defina "correctOptionLetter" como "N/A" e "correctAnswer" como -1.
        * Forneça uma "suggestedAnswer" (resposta modelo escrita de forma clara, acessível e objetiva, focada na ideia central sem exigir jargões excessivamente técnicos) e "explanation" (critérios de correção flexíveis que valorizem o entendimento do conceito com as próprias palavras do aluno).`,
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.NUMBER },
              type: { type: Type.STRING, enum: ["MULTIPLE_CHOICE", "OPEN_ENDED"] },
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctOptionLetter: {
                type: Type.STRING,
                enum: ["A", "B", "C", "D", "E", "N/A"],
              },
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "correctOptionLetter", "correctAnswer", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      if (!Array.isArray(generated) || generated.length === 0) {
        throw new Error("O modelo não retornou questões válidas. Tente novamente.");
      }
      return await processAndSyncQuizQuestions(generated);
    } catch (e: any) {
      console.error("Erro ao gerar simulado", e);
      throw e;
    }
  },

  async evaluateOpenAnswer(question: string, suggestedAnswer: string, userAnswer: string): Promise<EvaluationResult> {
    const qNorm = normalizeText(question || "");
    const aNorm = normalizeText(userAnswer || "");
    const cacheDocId = `v2_flex_${qNorm.slice(0, 40)}_${aNorm.slice(0, 40)}_${simpleHash(qNorm + "::" + aNorm)}`;
    const evalRef = doc(db, "evaluated_answers", cacheDocId);

    if (qNorm && aNorm) {
      try {
        const snap = await getDoc(evalRef);
        if (snap.exists()) {
          const data = snap.data();
          if (typeof data.score === "number" && typeof data.feedback === "string") {
            return { score: data.score, feedback: data.feedback };
          }
        }
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.GET, `evaluated_answers/${cacheDocId}`);
        } catch (logErr) {
          console.error("Firestore Error Info Logged (GET evaluated_answers):", logErr);
        }
      }
    }

    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Você é um professor compreensivo, didático e flexível avaliando a resposta de um aluno para uma questão dissertativa.

      Questão: "${question}"
      Referência de Resposta (apenas guia conceitual): "${suggestedAnswer}"
      Resposta do Aluno: "${userAnswer}"
      
      DIRETRIZES OBRIGATÓRIAS DE CORREÇÃO (SEJA MALEÁVEL E NÃO EXIJA TECNICISMO):
      1. NÃO exija termos técnicos, jargões acadêmicos formais ou reprodução literal da Referência de Resposta.
      2. Avalie a INTENÇÃO e a DIREÇÃO do raciocínio: se o aluno demonstrou que compreendeu a ideia central ou foi na direção correta usando suas próprias palavras (mesmo de forma simples, direta, resumida ou cotidiana), valorize isso com uma pontuação alta!
      3. A Referência de Resposta é apenas uma base conceitual. O aluno NÃO precisa citar todos os detalhes ou usar vocabulário técnico para receber nota máxima ou excelente.
      4. Escala de Pontuação Generosa e Flexível (0 a 100):
         - 85 a 100 pontos: O aluno está na direção correta e captou a ideia principal da pergunta, mesmo explicando de forma simples, curta ou sem termos técnicos. Se a lógica central estiver certa, atribua entre 90 e 100.
         - 70 a 84 pontos: O aluno foi na direção certa e mostrou boa noção do conceito, mesmo que a resposta esteja incompleta ou superficial em algum ponto secundário.
         - 50 a 69 pontos: O aluno tangenciou a resposta correta ou acertou apenas uma parte da ideia, demonstrando entendimento parcial.
         - 0 a 49 pontos: Apenas quando a resposta estiver totalmente incorreta, contradizer o conceito básico ou fugir completamente do tema.
      5. No campo "feedback", escreva em português de forma encorajadora e construtiva: valide primeiro o que o aluno acertou na sua linha de raciocínio e complemente de maneira leve e acessível.

      Retorne em formato JSON com os campos "score" (número inteiro de 0 a 100) e "feedback" (string).`,
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.NUMBER },
            feedback: { type: Type.STRING },
          },
          required: ["score", "feedback"],
        },
      },
    }));

    try {
      const parsed: EvaluationResult = JSON.parse(response.text || '{"score": 0, "feedback": "Erro na avaliação"}');
      const finalResult: EvaluationResult = {
        score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
        feedback: parsed.feedback || "Avaliação concluída.",
      };

      if (qNorm && aNorm && question.length < 10000 && userAnswer.length < 10000) {
        try {
          await setDoc(evalRef, {
            question,
            userAnswer,
            score: finalResult.score,
            feedback: finalResult.feedback,
            createdAt: serverTimestamp(),
          });
        } catch (err) {
          try {
            handleFirestoreError(err, OperationType.WRITE, `evaluated_answers/${cacheDocId}`);
          } catch (logErr) {
            console.error("Firestore Error Info Logged (WRITE evaluated_answers):", logErr);
          }
        }
      }

      return finalResult;
    } catch (e) {
      console.error("Erro ao avaliar resposta", e);
      return { score: 0, feedback: "Erro ao processar avaliação." };
    }
  },

  async generateQuizFromText(userQuestions: string): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `O usuário forneceu o seguinte conteúdo para um simulado:
      "${userQuestions}"
      
      Gere um simulado completo baseado ESTRITAMENTE nesse conteúdo seguindo estas regras:
      1. O simulado deve ter EXATAMENTE 10 questões de múltipla escolha (MULTIPLE_CHOICE) e 6 questões discursivas (OPEN_ENDED).
      2. Se o conteúdo contiver mais de 10 questões de múltipla escolha, selecione as 10 mais relevantes e com maior probabilidade de cair em uma prova oficial.
      3. Se o conteúdo contiver questões prontas, siga ESTRITAMENTE as perguntas e a ordem exata das alternativas fornecidas (remova apenas prefixos como "A)", "B)" do início do texto de cada alternativa em "options").
      4. REGRA CRÍTICA DE GABARITO (MULTIPLE_CHOICE):
         - Identifique a alternativa correta com precisão.
         - Preencha "correctOptionLetter" com a letra exata da alternativa correta ("A" para a 1ª opção, "B" para a 2ª, "C" para a 3ª, "D" para a 4ª, "E" para a 5ª).
         - Preencha "correctAnswer" com o índice BASEADO EM ZERO correspondente (0 para A, 1 para B, 2 para C, 3 para D, 4 para E).
         - Comece SEMPRE o campo "explanation" com "Alternativa correta: <LETRA>." (ex: "Alternativa correta: C. ...") garantindo total sincronia entre o índice, a letra e a explicação.
      5. IMPORTANTE: Preserve e MELHORE a formatação. Use quebras de linha claras (\n\n) entre sentenças ou tópicos para evitar blocos de texto densos. Se houver itens numerados ou com letras no enunciado, coloque cada um em uma nova linha.
      6. Se não houver questões discursivas no conteúdo, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha fornecidas.
      7. Para as questões discursivas (OPEN_ENDED), defina "correctOptionLetter" como "N/A", "correctAnswer" como -1, e forneça "suggestedAnswer" (resposta modelo clara, direta e sem excesso de tecnicismo) e "explanation" (critérios de correção flexíveis que valorizem o raciocínio na direção certa).
      
      Traduza para o português se necessário.`,
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.NUMBER },
              type: { type: Type.STRING, enum: ["MULTIPLE_CHOICE", "OPEN_ENDED"] },
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctOptionLetter: {
                type: Type.STRING,
                enum: ["A", "B", "C", "D", "E", "N/A"],
              },
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "correctOptionLetter", "correctAnswer", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      if (!Array.isArray(generated) || generated.length === 0) {
        throw new Error("O modelo não retornou questões válidas a partir do texto fornecido.");
      }
      return await processAndSyncQuizQuestions(generated);
    } catch (e: any) {
      console.error("Erro ao gerar simulado a partir de texto", e);
      throw e;
    }
  },

  async generateQuizFromMedia(mediaItems: { base64Data: string, mimeType: string }[]): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [
        {
          parts: [
            ...mediaItems.map(item => ({
              inlineData: {
                data: item.base64Data,
                mimeType: item.mimeType,
              },
            })),
            {
              text: `Analise os arquivos fornecidos e gere um simulado completo seguindo estas regras:
              1. O simulado deve ter EXATAMENTE 10 questões de múltipla escolha (MULTIPLE_CHOICE) e 6 questões discursivas (OPEN_ENDED).
              2. Se os arquivos contiverem mais de 10 questões de múltipla escolha, selecione as 10 mais relevantes e com maior probabilidade de cair em uma prova oficial.
              3. Se houver questões prontas nos arquivos, siga ESTRITAMENTE as perguntas e a ordem exata das alternativas fornecidas (remova apenas prefixos como "A)", "B)" do início do texto de cada alternativa em "options").
              4. REGRA CRÍTICA DE GABARITO (MULTIPLE_CHOICE):
                 - Identifique a alternativa correta com precisão.
                 - Preencha "correctOptionLetter" com a letra exata da alternativa correta ("A" para a 1ª opção, "B" para a 2ª, "C" para a 3ª, "D" para a 4ª, "E" para a 5ª).
                 - Preencha "correctAnswer" com o índice BASEADO EM ZERO correspondente (0 para A, 1 para B, 2 para C, 3 para D, 4 para E).
                 - Comece SEMPRE o campo "explanation" com "Alternativa correta: <LETRA>." (ex: "Alternativa correta: C. ...") garantindo total sincronia entre o índice, a letra e a explicação.
              5. IMPORTANTE: Melhore a legibilidade do texto extraído. Use quebras de linha duplas (\n\n) para separar parágrafos e tópicos. Se a questão tiver itens (I, II, III...), coloque cada um em sua própria linha.
              6. Se não houver questões discursivas nos arquivos, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha identificadas.
              7. Para as questões discursivas (OPEN_ENDED), defina "correctOptionLetter" como "N/A", "correctAnswer" como -1, e forneça "suggestedAnswer" (resposta modelo clara, direta e sem excesso de tecnicismo) e "explanation" (critérios de correção flexíveis que valorizem o raciocínio na direção certa).
              
              Traduza para o português se necessário.`,
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.NUMBER },
              type: { type: Type.STRING, enum: ["MULTIPLE_CHOICE", "OPEN_ENDED"] },
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctOptionLetter: {
                type: Type.STRING,
                enum: ["A", "B", "C", "D", "E", "N/A"],
              },
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "correctOptionLetter", "correctAnswer", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      if (!Array.isArray(generated) || generated.length === 0) {
        throw new Error("O modelo não retornou questões válidas a partir dos arquivos fornecidos.");
      }
      return await processAndSyncQuizQuestions(generated);
    } catch (e: any) {
      console.error("Erro ao gerar simulado a partir de mídia", e);
      throw e;
    }
  },

  async getQuickAnswer(text?: string, mediaItems?: { base64Data: string, mimeType: string }[]): Promise<{ answer: string, explanation: string }[]> {
    const ai = getAI();
    
    const parts: any[] = [];
    if (mediaItems) {
      mediaItems.forEach(item => {
        parts.push({
          inlineData: {
            data: item.base64Data,
            mimeType: item.mimeType,
          }
        });
      });
    }
    
    parts.push({
      text: `Você é um assistente de estudos. O usuário enviou uma ou mais perguntas (via texto ou imagem).
      Analise todo o conteúdo fornecido. Se houver múltiplas questões ou dúvidas em diferentes arquivos ou no texto, identifique cada uma delas.
      Para cada questão identificada, forneça a resposta correta e uma explicação breve e didática.
      
      IMPORTANTE: Se o conteúdo estiver em inglês e não for sobre o aprendizado de inglês, traduza para o português.
      Retorne SEMPRE um ARRAY de objetos JSON, mesmo que haja apenas uma pergunta.
      Cada objeto deve ter os campos "answer" e "explanation".
      ${text ? `Conteúdo em texto: "${text}"` : ""}`
    });

    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [{ parts }],
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["answer", "explanation"],
          },
        },
      },
    }));

    try {
      const results = JSON.parse(response.text || "[]");
      return Array.isArray(results) ? results : [results];
    } catch (e: any) {
      console.error("Erro ao obter resposta rápida", e);
      throw e;
    }
  },

  async generateAssignment(instructions: string, mediaItems?: { base64Data: string, mimeType: string }[]): Promise<Assignment> {
    const ai = getAI();
    const parts: any[] = [];
    if (mediaItems) {
      mediaItems.forEach(item => {
        parts.push({
          inlineData: {
            data: item.base64Data,
            mimeType: item.mimeType,
          }
        });
      });
    }
    
    parts.push({
      text: `Você é um assistente acadêmico especializado em produzir trabalhos escolares e universitários de alta qualidade.
      O usuário deseja que você ajude a realizar um trabalho baseado nas seguintes instruções:
      
      INSTRUAÇÕES: "${instructions}"
      
      Se houver arquivos (PDFs ou Imagens), use-os como base principal para estruturar o trabalho, extraindo informações relevantes e citando-as quando apropriado.
      
      O trabalho deve seguir uma estrutura acadêmica formal e organizada:
      1. Título impactante e apropriado.
      2. Introdução que apresenta o tema e os objetivos.
      3. Desenvolvimento dividido em seções temáticas coerentes.
      4. Conclusão que sintetiza os aprendizados.
      5. Referências Bibliográficas formatadas.
      
      Estruture o conteúdo de cada seção de forma detalhada, informativa e bem escrita.
      
      Retorne um objeto JSON com a seguinte estrutura:
      - "title": string
      - "introduction": string (pode conter markdown)
      - "sections": array de { "title": string, "content": string (pode conter markdown) }
      - "conclusion": string (pode conter markdown)
      - "references": array de strings
      
      IMPORTANTE: Use markdown dentro dos campos de texto para itálico, negrito, listas, etc.
      Retorne APENAS o objeto JSON.`
    });

    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [{ parts }],
      config: {
        temperature: 0,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            introduction: { type: Type.STRING },
            sections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  content: { type: Type.STRING },
                },
                required: ["title", "content"],
              },
            },
            conclusion: { type: Type.STRING },
            references: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["title", "introduction", "sections", "conclusion", "references"],
        },
      },
    }));

    try {
      return JSON.parse(response.text || "{}");
    } catch (e) {
      console.error("Erro ao gerar trabalho", e);
      throw new Error("Erro ao formatar o trabalho acadêmico. Tente novamente.");
    }
  },
};
