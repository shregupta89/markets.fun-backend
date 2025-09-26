// src/routes/markets.js
const express = require('express');
const supabase = require('../services/supabase');
const blockchainService = require('../services/blockchain');

const router = express.Router();

// Get active markets
router.get('/active', async (req, res) => {
  try {
    const { category, limit = 20 } = req.query;

    // Try to get from blockchain first
    let markets;
    try {
      markets = await blockchainService.getActiveMarkets();
    } catch (blockchainError) {
      console.warn('Blockchain unavailable, using cached data:', blockchainError.message);
      
      // Fallback to database cache
      let query = supabase
        .from('markets')
        .select('*')
        .eq('resolved', false)
        .gte('end_time', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(parseInt(limit));

      if (category) {
        query = query.eq('category', category);
      }

      const { data, error } = await query;
      
      if (error) {
        throw error;
      }

      markets = data;
    }

    // If no real markets, provide demo markets
    if (!markets || markets.length === 0) {
      markets = [
        {
          id: 0,
          question: "Will Lakers win their next game?",
          category: "sports",
          endTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          totalYes: "150.5",
          totalNo: "89.2",
          resolved: false,
          created_at: new Date().toISOString()
        },
        {
          id: 1,
          question: "Will Bitcoin hit $100k by end of month?",
          category: "finance",
          endTime: new Date(Date.now() + 86400000 * 7).toISOString(), // 7 days
          totalYes: "89.7",
          totalNo: "110.3",
          resolved: false,
          created_at: new Date().toISOString()
        },
        {
          id: 2,
          question: "Will it rain tomorrow in New York?",
          category: "weather",
          endTime: new Date(Date.now() + 86400000).toISOString(), // 1 day
          totalYes: "45.2",
          totalNo: "67.8",
          resolved: false,
          created_at: new Date().toISOString()
        }
      ];
    }

    res.json({
      markets,
      source: markets.length > 0 ? 'blockchain' : 'demo',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Active markets error:', error);
    res.status(500).json({ error: 'Failed to fetch active markets' });
  }
});

// Get specific market details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Try blockchain first
    let market;
    try {
      market = await blockchainService.getMarket(parseInt(id));
    } catch (blockchainError) {
      console.warn('Blockchain unavailable for market details:', blockchainError.message);
      
      // Fallback to database
      const { data, error } = await supabase
        .from('markets')
        .select('*')
        .eq('id', parseInt(id))
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Market not found' });
      }

      market = data;
    }

    // Get recent trades for this market
    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .select(`
        *,
        users(wallet_address)
      `)
      .eq('market_id', parseInt(id))
      .order('timestamp', { ascending: false })
      .limit(10);

    if (tradesError) {
      console.warn('Could not fetch recent trades:', tradesError.message);
    }

    res.json({
      market,
      recentTrades: trades || [],
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Market details error:', error);
    res.status(500).json({ error: 'Failed to fetch market details' });
  }
});

// Create new market (no auth required, wallet address in body)
router.post('/create', async (req, res) => {
  try {
    const { walletAddress, question, category, duration } = req.body;

    if (!walletAddress || !question || !category || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure user exists
    const { data: user, error: userError } = await supabase
      .from('users')
      .upsert({ wallet_address: walletAddress.toLowerCase() })
      .select()
      .single();

    if (userError) {
      console.error('User creation error:', userError);
      return res.status(500).json({ error: 'Database error' });
    }

    // Create market on blockchain
    let marketId;
    try {
      marketId = await blockchainService.createMarket(question, duration);
    } catch (blockchainError) {
      console.error('Blockchain market creation failed:', blockchainError);
      return res.status(500).json({ error: 'Failed to create market on blockchain' });
    }

    // Store in database
    const endTime = new Date(Date.now() + duration * 1000);
    const { data: market, error } = await supabase
      .from('markets')
      .insert({
        id: marketId,
        question,
        category,
        creator_id: user.id,
        end_time: endTime,
        total_yes: '0',
        total_no: '0',
        resolved: false
      })
      .select()
      .single();

    if (error) {
      console.error('Database market creation failed:', error);
      // Market exists on blockchain but not in DB - this is OK for demo
    }

    res.json({
      marketId,
      market: market || {
        id: marketId,
        question,
        category,
        endTime: endTime.toISOString(),
        totalYes: '0',
        totalNo: '0',
        resolved: false
      }
    });

  } catch (error) {
    console.error('Market creation error:', error);
    res.status(500).json({ error: 'Failed to create market' });
  }
});

// Place bet on market (no auth required, wallet address in body)
router.post('/:id/bet', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, prediction, amount } = req.body; // prediction: true/false, amount: string

    if (!walletAddress || typeof prediction !== 'boolean' || !amount) {
      return res.status(400).json({ error: 'Invalid bet parameters' });
    }

    // Ensure user exists
    const { data: user, error: userError } = await supabase
      .from('users')
      .upsert({ wallet_address: walletAddress.toLowerCase() })
      .select()
      .single();

    if (userError) {
      console.error('User creation error:', userError);
      return res.status(500).json({ error: 'Database error' });
    }

    // Place bet on blockchain
    let txHash;
    try {
      txHash = await blockchainService.placeBet(parseInt(id), prediction, amount);
    } catch (blockchainError) {
      console.error('Blockchain bet failed:', blockchainError);
      return res.status(500).json({ error: 'Failed to place bet on blockchain' });
    }

    // Store in database
    const { data: trade, error } = await supabase
      .from('trades')
      .insert({
        user_id: user.id,
        market_id: parseInt(id),
        prediction,
        amount,
        tx_hash: txHash,
        timestamp: new Date()
      })
      .select()
      .single();

    if (error) {
      console.error('Database trade recording failed:', error);
      // Trade exists on blockchain but not in DB - this is OK for demo
    }

    res.json({
      txHash,
      trade: trade || {
        id: Date.now(), // temporary ID
        user_id: user.id,
        market_id: parseInt(id),
        prediction,
        amount,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Bet placement error:', error);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// Get market categories
router.get('/categories/list', async (req, res) => {
  try {
    const categories = [
      { id: 'sports', name: 'Sports', count: 15 },
      { id: 'politics', name: 'Politics', count: 8 },
      { id: 'finance', name: 'Finance', count: 12 },
      { id: 'weather', name: 'Weather', count: 5 },
      { id: 'entertainment', name: 'Entertainment', count: 7 },
      { id: 'technology', name: 'Technology', count: 9 }
    ];

    res.json(categories);
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

module.exports = router;