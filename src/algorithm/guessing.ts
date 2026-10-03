import prisma from '../prisma';

const ANSWER_MAPPING: Record<string, number> = {
  'yes': 1.0,
  'probably_yes': 0.75,
  'dont_know': 0.5,
  'probably_no': 0.25,
  'no': 0.0,
};

export async function calculateInitialProbabilities() {
  const characters = await prisma.character.findMany();
  const prior = 1.0 / characters.length;
  
  const probabilities: Record<number, number> = {};
  for (const c of characters) {
    probabilities[c.id] = prior;
  }
  return probabilities;
}

export async function updateProbabilities(
  currentProbs: Record<number, number>,
  questionId: number,
  answerValue: number
) {
  const characters = Object.keys(currentProbs).map(Number);
  
  // Get all weights for this question
  const answers = await prisma.characterAnswer.findMany({
    where: { questionId, characterId: { in: characters } }
  });
  
  const weightsMap: Record<number, number> = {};
  for (const a of answers) {
    weightsMap[a.characterId] = a.weight;
  }
  
  const newProbs: Record<number, number> = {};
  let totalProb = 0;
  
  for (const charId of characters) {
    // Default weight is 0.5 if not found
    const expectedWeight = weightsMap[charId] ?? 0.5;
    
    // Calculate the difference between expected and actual answer
    let diff = Math.abs(expectedWeight - answerValue);
    
    // Calculate probability of this answer given the character.
    // We use a floor of 0.05 to ensure NO character is ever permanently eliminated 
    // due to a single mistake by the user or an incomplete database.
    let pAnswerGivenChar = Math.max(0.05, 1 - diff);
    
    // We can boost exact matches slightly to make the algorithm "confident" faster
    if (diff <= 0.1) {
      pAnswerGivenChar *= 1.5; 
    }
    
    // P(Character | Answer) = P(Answer | Character) * P(Character)
    const unnormalizedProb = pAnswerGivenChar * currentProbs[charId];
    newProbs[charId] = unnormalizedProb;
    totalProb += unnormalizedProb;
  }
  
  // Normalize
  if (totalProb > 0) {
    for (const charId of characters) {
      newProbs[charId] /= totalProb;
    }
  }
  
  return newProbs;
}

export async function getBestNextQuestion(
  currentProbs: Record<number, number>,
  askedQuestions: number[]
) {
  // Find a question that has highest entropy (divides the probable characters in half)
  const availableQuestions = await prisma.question.findMany({
    where: { id: { notIn: askedQuestions } },
    include: { answers: true }
  });
  
  if (availableQuestions.length === 0) return null;
  
  let bestQuestion = null;
  let maxEntropy = -1;
  
  for (const q of availableQuestions) {
    const weightsMap: Record<number, number> = {};
    for (const a of q.answers) {
      weightsMap[a.characterId] = a.weight;
    }
    
    // Calculate expected value of "Yes" for this question
    // E(Yes) = sum(P(C) * weight(C))
    let pYes = 0;
    for (const [charIdStr, prob] of Object.entries(currentProbs)) {
      const charId = Number(charIdStr);
      const w = weightsMap[charId] ?? 0.5;
      pYes += prob * w;
    }
    
    // Entropy formula: -p*log(p) - (1-p)*log(1-p)
    // To maximize entropy, pYes should be close to 0.5
    // We add a tiny random factor to break ties naturally
    const entropyScore = 0.5 - Math.abs(pYes - 0.5) + (Math.random() * 0.01);
    
    // Ignore practically useless questions if we can
    if (entropyScore < 0.02 && availableQuestions.length > 5) continue;

    if (entropyScore > maxEntropy) {
      maxEntropy = entropyScore;
      bestQuestion = q;
    }
  }
  
  // Fallback if all remaining questions were ignored
  if (!bestQuestion && availableQuestions.length > 0) {
    bestQuestion = availableQuestions[0];
  }
  
  return bestQuestion;
}
