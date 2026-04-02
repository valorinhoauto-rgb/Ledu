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

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correctAnswer: number; // index
  explanation: string;
}

export interface StudyTopic {
  title: string;
  content: string;
}

export const geminiService = {
  async getStudyTopics(subject: string): Promise<StudyTopic[]> {
    const ai = getAI();
    const response = await ai.models.generateContent({
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
    });

    try {
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao parsear tópicos de estudo", e);
      return [];
    }
  },

  async generateQuiz(subject: string, numQuestions: number): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: `Gere um simulado de ${numQuestions} questões sobre o tema: "${subject}".
      As questões devem ser de múltipla escolha (4 opções).
      Retorne em formato JSON: uma lista de objetos com "id", "question", "options" (array de strings), "correctAnswer" (índice 0-3) e "explanation".`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.NUMBER },
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctAnswer: { type: Type.NUMBER },
              explanation: { type: Type.STRING },
            },
            required: ["id", "question", "options", "correctAnswer", "explanation"],
          },
        },
      },
    });

    try {
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao gerar simulado", e);
      return [];
    }
  },

  async generateQuizFromText(userQuestions: string): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: `O usuário forneceu o seguinte texto contendo questões ou conteúdo para um simulado:
      "${userQuestions}"
      
      IMPORTANTE: Se o conteúdo estiver em inglês e o tema não for especificamente sobre o aprendizado da língua inglesa, traduza o conteúdo para o português antes de gerar as questões. O simulado final deve estar sempre em português, a menos que o objetivo seja testar conhecimentos de inglês.

      Organize esse conteúdo em um simulado estruturado de múltipla escolha. 
      Se o texto já tiver questões, formate-as. Se for apenas conteúdo, crie questões baseadas nele.
      Retorne em formato JSON: uma lista de objetos com "id", "question", "options" (array de strings), "correctAnswer" (índice 0-3) e "explanation".`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.NUMBER },
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctAnswer: { type: Type.NUMBER },
              explanation: { type: Type.STRING },
            },
            required: ["id", "question", "options", "correctAnswer", "explanation"],
          },
        },
      },
    });

    try {
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Erro ao gerar simulado a partir de texto", e);
      return [];
    }
  },

  async generateQuizFromMedia(mediaItems: { base64Data: string, mimeType: string }[]): Promise<QuizQuestion[]> {
    const ai = getAI();
    const response = await ai.models.generateContent({
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
              text: `Analise os arquivos fornecidos (imagens ou PDFs) que contêm questões ou conteúdo educacional.
              
              IMPORTANTE: Se o conteúdo dos arquivos estiver em inglês e o tema não for especificamente sobre o aprendizado da língua inglesa, traduza o conteúdo para o português antes de gerar as questões. O simulado final deve estar sempre em português, a menos que o objetivo seja testar conhecimentos de inglês.

              Organize todo esse conteúdo em um simulado estruturado de múltipla escolha. 
              Retorne em formato JSON: uma lista de objetos com "id", "question", "options" (array de strings), "correctAnswer" (índice 0-3) e "explanation".`,
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
              question: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctAnswer: { type: Type.NUMBER },
              explanation: { type: Type.STRING },
            },
            required: ["id", "question", "options", "correctAnswer", "explanation"],
          },
        },
      },
    });

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

    const response = await ai.models.generateContent({
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
    });

    try {
      const results = JSON.parse(response.text || "[]");
      return Array.isArray(results) ? results : [results];
    } catch (e) {
      console.error("Erro ao obter resposta rápida", e);
      return [{ answer: "Erro", explanation: "Ocorreu um erro ao processar sua pergunta." }];
    }
  },
};
