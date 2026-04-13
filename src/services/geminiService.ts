import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

// Função para obter a chave de forma dinâmica
const getApiKey = () => {
  // 1. Tenta pegar do localStorage (caso você queira testar com outra chave)
  const localKey = typeof window !== 'undefined' ? localStorage.getItem("LEDU_API_KEY") : null;
  if (localKey) return localKey;

  // 2. Tenta pegar da variável de ambiente do Vite (para o Netlify)
  // Usamos uma técnica para evitar erro de lint/typescript
  const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (envKey) return envKey;

  // 3. Fallback para o ambiente de desenvolvimento do AI Studio
  return (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : "") || "";
};

// Criamos uma função que retorna a instância do AI sempre atualizada
const getAI = () => {
  const key = getApiKey();
  return new GoogleGenAI({ apiKey: key });
};

export interface StudyTopic {
  title: string;
  content: string;
}

// Função auxiliar para lidar com retentativas em caso de erro de cota (429)
const withRetry = async <T>(fn: () => Promise<T>, maxRetries = 3, delay = 2000): Promise<T> => {
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

export const geminiService = {
  async getStudyTopics(subject: string): Promise<StudyTopic[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: `Você é um tutor especializado. O aluno quer estudar sobre: "${subject}". 
      Forneça uma lista de tópicos principais com explicações claras, intuitivas e didáticas.
      Retorne em formato JSON: uma lista de objetos com "title" e "content" (em markdown).`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      model: "gemini-3.1-flash-lite-preview",
      contents: `Gere um simulado completo sobre o tema: "${subject}".
      O simulado deve conter EXATAMENTE:
      1. 10 questões de múltipla escolha (tipo MULTIPLE_CHOICE) com 4 opções cada.
      2. 6 questões discursivas (tipo OPEN_ENDED) para que o aluno escolha 3 para responder.
      
      Para as questões de múltipla escolha, forneça "options" (array de strings), "correctAnswer" (índice 0-3) e "explanation".
      Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
      
      Retorne em formato JSON: uma lista de objetos com "id", "type" ("MULTIPLE_CHOICE" ou "OPEN_ENDED"), "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao gerar simulado", e);
      return [];
    }
  },

  async evaluateOpenAnswer(question: string, suggestedAnswer: string, userAnswer: string): Promise<EvaluationResult> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: `Avalie a resposta do aluno para a seguinte questão discursiva:
      Questão: "${question}"
      Resposta Modelo: "${suggestedAnswer}"
      Resposta do Aluno: "${userAnswer}"
      
      Atribua uma nota de 0 a 100 baseada na precisão e completude em relação à resposta modelo.
      Forneça um feedback construtivo em português.
      Retorne em formato JSON com os campos "score" (número) e "feedback" (string).`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      model: "gemini-3.1-flash-lite-preview",
      contents: `O usuário forneceu o seguinte conteúdo para um simulado:
      "${userQuestions}"
      
      Gere um simulado completo baseado ESTRITAMENTE nesse conteúdo seguindo estas regras:
      1. O simulado deve ter EXATAMENTE 10 questões de múltipla escolha (MULTIPLE_CHOICE) e 6 questões discursivas (OPEN_ENDED).
      2. Se o conteúdo contiver mais de 10 questões de múltipla escolha, selecione as 10 mais relevantes e com maior probabilidade de cair em uma prova oficial.
      3. Se o conteúdo contiver questões prontas, siga ESTRITAMENTE as perguntas e alternativas fornecidas (não parafraseie, pois elas costumam se repetir exatamente na prova).
      4. Se não houver questões discursivas no conteúdo, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha fornecidas.
      5. Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
      
      Traduza para o português se necessário.
      Retorne em formato JSON: uma lista de objetos com "id", "type", "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao gerar simulado a partir de texto", e);
      return [];
    }
  },

  async generateQuizFromMedia(mediaItems: { base64Data: string, mimeType: string }[]): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
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
              3. Se houver questões prontas nos arquivos, siga ESTRITAMENTE as perguntas e alternativas fornecidas (não parafraseie, pois elas costumam se repetir exatamente na prova).
              4. Se não houver questões discursivas nos arquivos, crie 6 questões discursivas baseadas nos temas abordados nas questões de múltipla escolha identificadas.
              5. Para as questões discursivas, forneça uma "suggestedAnswer" (resposta modelo) e "explanation" (critérios de correção).
              
              Traduza para o português se necessário.
              Retorne em formato JSON: uma lista de objetos com "id", "type", "question", "options", "correctAnswer", "suggestedAnswer" e "explanation".`,
            },
          ],
        },
      ],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
      return JSON.parse(response.text || "[]");
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
      model: "gemini-3.1-flash-lite-preview",
      contents: [{ parts }],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
};
