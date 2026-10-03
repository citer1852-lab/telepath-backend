import { Router } from 'express';
import prisma from '../prisma';
import { calculateInitialProbabilities, getBestNextQuestion, updateProbabilities } from '../algorithm/guessing';

const router = Router();

// Mapping for answers
const ANSWER_MAPPING: Record<string, number> = {
  'yes': 1.0,
  'probably_yes': 0.75,
  'dont_know': 0.5,
  'probably_no': 0.25,
  'no': 0.0,
};

router.post('/start', async (req, res) => {
  try {
    const initialProbs = await calculateInitialProbabilities();
    const firstQuestion = await getBestNextQuestion(initialProbs, []);
    
    if (!firstQuestion) {
      return res.status(400).json({ error: 'No questions in database' });
    }

    const session = await prisma.session.create({
      data: {
        state: 'playing',
        step: 1,
        probabilities: JSON.stringify(initialProbs),
        history: "[]",
      }
    });

    res.json({
      sessionId: session.id,
      question: {
        id: firstQuestion.id,
        text: firstQuestion.text,
      },
      step: session.step
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/answer', async (req, res) => {
  try {
    const { sessionId, questionId, answer } = req.body;
    
    if (!sessionId || !questionId || !answer) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.state !== 'playing') return res.status(400).json({ error: 'Session is not active' });

    const answerValue = ANSWER_MAPPING[answer];
    if (answerValue === undefined) return res.status(400).json({ error: 'Invalid answer' });

    // Update probabilities
    const currentProbs = JSON.parse(session.probabilities) as Record<number, number>;
    const history = JSON.parse(session.history) as any[];
    
    history.push({ questionId, answerValue, answer });
    
    const newProbs = await updateProbabilities(currentProbs, questionId, answerValue);
    
    // Check if we have a winner (>90% probability)
    let bestCharId = -1;
    let maxProb = -1;
    for (const [charId, prob] of Object.entries(newProbs)) {
      if (prob > maxProb) {
        maxProb = prob;
        bestCharId = Number(charId);
      }
    }

    // Threshold for guessing is 0.75 (75%) or max 20 questions
    if (maxProb > 0.75 || session.step >= 20) {
      // Time to guess
      const character = await prisma.character.findUnique({ where: { id: bestCharId } });
      
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          state: 'guessed',
          probabilities: JSON.stringify(newProbs),
          history: JSON.stringify(history),
          step: session.step + 1
        }
      });
      
      return res.json({
        sessionId,
        guessed: true,
        character,
        probability: maxProb
      });
    }

    // Get next question
    const askedQuestions = history.map(h => h.questionId);
    const nextQuestion = await getBestNextQuestion(newProbs, askedQuestions);
    
    if (!nextQuestion) {
       // No more questions, force guess
       const character = await prisma.character.findUnique({ where: { id: bestCharId } });
       
       await prisma.session.update({
         where: { id: sessionId },
         data: {
           state: 'guessed',
           probabilities: JSON.stringify(newProbs),
           history: JSON.stringify(history),
           step: session.step + 1
         }
       });
       
       return res.json({
         sessionId,
         guessed: true,
         character,
         probability: maxProb
       });
    }

    // Continue game
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        probabilities: JSON.stringify(newProbs),
        history: JSON.stringify(history),
        step: session.step + 1
      }
    });

    res.json({
      sessionId,
      guessed: false,
      question: {
        id: nextQuestion.id,
        text: nextQuestion.text
      },
      step: session.step + 1,
      topProbability: maxProb
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User confirms if the guess was correct or wrong
router.post('/confirm', async (req, res) => {
  try {
    const { sessionId, correct } = req.body;
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    await prisma.session.update({
      where: { id: sessionId },
      data: { state: 'finished' }
    });
    
    // Here we could implement automatic learning based on history if the guess was correct,
    // but for now, we just close the session.
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
