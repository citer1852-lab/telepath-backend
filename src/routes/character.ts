import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// Endpoint for learning new characters
router.post('/learn', async (req, res) => {
  try {
    const { sessionId, name, description, imageUrl } = req.body;
    
    if (!sessionId || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    // Check if character already exists
    let character = await prisma.character.findUnique({ where: { name } });
    
    if (!character) {
      character = await prisma.character.create({
        data: {
          name,
          description,
          imageUrl
        }
      });
    }

    // Update weights based on this session's history
    const history = JSON.parse(session.history) as { questionId: number, answerValue: number }[];
    
    for (const h of history) {
      // Find existing answer
      const existing = await prisma.characterAnswer.findUnique({
        where: {
          characterId_questionId: {
            characterId: character.id,
            questionId: h.questionId
          }
        }
      });
      
      if (existing) {
        // Simple moving average (learning rate)
        // In a real scenario, we might want to track total times answered and do a proper average
        const newWeight = (existing.weight * 0.8) + (h.answerValue * 0.2);
        
        await prisma.characterAnswer.update({
          where: { id: existing.id },
          data: { weight: newWeight }
        });
      } else {
        await prisma.characterAnswer.create({
          data: {
            characterId: character.id,
            questionId: h.questionId,
            weight: h.answerValue
          }
        });
      }
    }

    await prisma.session.update({
      where: { id: sessionId },
      data: { state: 'finished' }
    });

    res.json({ success: true, character });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
