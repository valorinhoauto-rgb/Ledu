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
const getApiKey = () => {
  // 1. Tenta pegar da variável de ambiente do Vite (Recomendado para Netlify/Vercel)
  // No Netlify, configure como VITE_GEMINI_API_KEY
  const viteKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (viteKey) return viteKey;

  // 2. Fallback para process.env (Injetado pelo Vite via define no vite.config.ts)
  // Útil para o ambiente do AI Studio
  try {
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey) return envKey;
  } catch (e) {
    // process.env pode não estar definido no browser
  }

  // 3. Tenta pegar do localStorage (Último recurso para o usuário configurar manualmente no console)
  if (typeof window !== 'undefined') {
    const localKey = localStorage.getItem("LEMA_API_KEY");
    if (localKey) return localKey;
  }

  return "";
};

// Criamos uma função que retorna a instância do AI sempre atualizada
const getAI = () => {
  const key = getApiKey();
  // No AI Studio, process.env.GEMINI_API_KEY é injetado automaticamente.
  // O SDK @google/genai prefere a inicialização direta.
  return new GoogleGenAI({ apiKey: key });
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
  correctAnswer?: number; // Only for MULTIPLE_CHOICE
  explanation: string;
  suggestedAnswer?: string; // For OPEN_ENDED
}

export interface EvaluationResult {
  score: number; // 0 to 100
  feedback: string;
}

async function processAndSyncQuizQuestions(questions: QuizQuestion[]): Promise<QuizQuestion[]> {
  const processedQuestions: QuizQuestion[] = [];

  for (const q of questions) {
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
      
      const merged: QuizQuestion = {
        ...q,
        type: storedData.type as QuestionType,
        options: storedData.options || q.options,
        correctAnswer: storedData.correctAnswer !== undefined && storedData.correctAnswer !== null ? storedData.correctAnswer : q.correctAnswer,
        suggestedAnswer: storedData.suggestedAnswer || q.suggestedAnswer,
        explanation: storedData.explanation || q.explanation,
      };
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
        docData.correctAnswer = q.correctAnswer !== undefined ? q.correctAnswer : null;
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
      model: "gemini-3.5-flash",
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
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao parsear tópicos de estudo", e);
      return [];
    }
  },

  async generateQuiz(subject: string): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Gere um simulado completo sobre o tema: "${subject}".
      O simulado deve conter EXATAMENTE:
      1. 10 questões de múltipla escolha (tipo MULTIPLE_CHOICE) com 4 opções cada.
      2. 6 questões discursivas (tipo OPEN_ENDED) para que o aluno escolha 3 para responder.
      
      REGRAS DE FORMATAÇÃO:
      - Use quebras de linha duplas entre parágrafos.
      - Se a questão tiver itens (ex: I, II, III ou a, b, c), use listas ou quebras de linha claras para que não fiquem amontoados.
      - Garanta que o texto seja legível e bem estruturado.
      
      Para as questões de múltipla escolha, forneça "options" (array de strings), "correctAnswer" (índice 0-3) e "explanation".
      Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
      
      Retorne em formato JSON: uma lista de objetos com "id", "type" ("MULTIPLE_CHOICE" ou "OPEN_ENDED"), "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
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
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      return await processAndSyncQuizQuestions(generated);
    } catch (e) {
      console.error("Erro ao gerar simulado", e);
      return [];
    }
  },

  async evaluateOpenAnswer(question: string, suggestedAnswer: string, userAnswer: string): Promise<EvaluationResult> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Avalie a resposta do aluno para a seguinte questão discursiva:
      Questão: "${question}"
      Resposta Modelo: "${suggestedAnswer}"
      Resposta do Aluno: "${userAnswer}"
      
      Atribua uma nota de 0 a 100 baseada na precisão e completude em relação à resposta modelo.
      Forneça um feedback construtivo em português.
      Retorne em formato JSON com os campos "score" (número) e "feedback" (string).`,
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
      return JSON.parse(response.text || '{"score": 0, "feedback": "Erro na avaliação"}');
    } catch (e) {
      console.error("Erro ao avaliar resposta", e);
      return { score: 0, feedback: "Erro ao processar avaliação." };
    }
  },

  async generateQuizFromText(userQuestions: string): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `O usuário forneceu o seguinte conteúdo para um simulado:
      "${userQuestions}"
      
      Gere um simulado completo baseado ESTRITAMENTE nesse conteúdo seguindo estas regras:
      1. O simulado deve ter EXATAMENTE 10 questões de múltipla escolha (MULTIPLE_CHOICE) e 6 questões discursivas (OPEN_ENDED).
      2. Se o conteúdo contiver mais de 10 questões de múltipla escolha, selecione as 10 mais relevantes e com maior probabilidade de cair em uma prova oficial.
      3. Se o conteúdo contiver questões prontas, siga ESTRITAMENTE as perguntas e alternativas fornecidas. Identifique e determine a alternativa correta de forma logicamente consistente, precisa e imparcial, garantindo que o gabarito corresponda de forma estrita à alternativa cientificamente/historicamente aceita ou informada no texto.
      4. IMPORTANTE: Preserve e MELHORE a formatação. Use quebras de linha claras (\n\n) entre sentenças ou tópicos para evitar blocos de texto densos. Se houver itens numerados ou com letras, coloque cada um em uma nova linha.
      5. Se não houver questões discursivas no conteúdo, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha fornecidas.
      6. Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
      
      Traduza para o português se necessário.
      Retorne em formato JSON: uma lista de objetos com "id", "type", "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
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
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      return await processAndSyncQuizQuestions(generated);
    } catch (e) {
      console.error("Erro ao gerar simulado a partir de texto", e);
      return [];
    }
  },

  async generateQuizFromMedia(mediaItems: { base64Data: string, mimeType: string }[]): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.5-flash",
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
              3. Se houver questões prontas nos arquivos, siga ESTRITAMENTE as perguntas e alternativas fornecidas. Identifique e determine a alternativa correta de forma logicamente consistente, precisa e imparcial, garantindo que o gabarito corresponda de forma estrita à alternativa cientificamente/historicamente aceita ou informada no texto.
              4. IMPORTANTE: Melhore a legibilidade do texto extraído. Use quebras de linha duplas (\n\n) para separar parágrafos e tópicos. Se a questão tiver itens (I, II, III...), coloque cada um em sua própria linha.
              5. Se não houver questões discursivas nos arquivos, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha identificadas.
              6. Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
              
              Traduza para o português se necessário.
              Retorne em formato JSON: uma lista de objetos com "id", "type", "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
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
              correctAnswer: { type: Type.NUMBER },
              suggestedAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["id", "type", "question", "explanation"],
          },
        },
      },
    }));

    try {
      const generated: QuizQuestion[] = JSON.parse(response.text || "[]");
      return await processAndSyncQuizQuestions(generated);
    } catch (e) {
      console.error("Erro ao gerar simulado a partir de mídia", e);
      return [];
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
      model: "gemini-3.5-flash",
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
    } catch (e) {
      console.error("Erro ao obter resposta rápida", e);
      return [{ answer: "Erro", explanation: "Ocorreu um erro ao processar sua pergunta." }];
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
      model: "gemini-3.5-flash",
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
