// src/routes/traders.js
const express = require('express');
const supabase = require('../services/supabase');
const substreamsService = require('../services/substreams');

const router = express.Router();

// Get leaderboard (powered by Substreams)
router.get('/leaderboard', async (req, res) => {
  try {
    const { category, limit = 50 } = req.query;

    // Try to get real-time data from Substreams first
    let traders;
    try {
      traders = await substreamsService.getTraderLeaderboard(category, limit);
    } catch (substreamsError) {
      console.warn('Substreams unavailable, using cached data:', substreamsError.message);
      
      // Fallback to cached database data
      let query = supabase
        .from('traders')
        .select(`
          *,
          users!inner(wallet_address, is_public)
        `)
        .eq('users.is_public', true)
        .order('win_rate', { ascending: false })
        .limit(parseInt(limit));

      if (category) {
        query = query.contains('categories', [category]);
      }

      const { data, error } = await query;
      
      if (error) {
        throw error;
      }

      traders = data.map(trader => ({
        address: trader.users.wallet_address,
        winRate: trader.win_rate,
        totalTrades: trader.total_trades,
        profitLoss: trader.profit_loss,
        totalVolume: trader.total_volume,
        categories: trader.categories || [],
        lastActive: trader.last_active
      }));
    }

    res.json({
      traders,
      source: traders.length > 0 ? 'substreams' : 'cache',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Leaderboard error:', error);
    
    // Ultimate fallback - mock data for demo
    const mockTraders = [
      {
        address: '0x1234567890123456789012345678901234567890',
        winRate: 78.5,
        totalTrades: 45,
        profitLoss: 1250.75,
        totalVolume: 5000,
        categories: ['sports', 'politics'],
        lastActive: new Date().toISOString()
      },
      {
        address: '0x0987654321098765432109876543210987654321',
        winRate: 65.2,
        totalTrades: 32,
        profitLoss: 890.25,
        totalVolume: 3200,
        categories: ['finance', 'sports'],
        lastActive: new Date().toISOString()
      },
      {
        address: '0x1111111111111111111111111111111111111111',
        winRate: 82.1,
        totalTrades: 28,
        profitLoss: 1580.50,
        totalVolume: 4100,
        categories: ['politics'],
        lastActive: new Date().toISOString()
      }
    ];

    res.json({
      traders: mockTraders,
      source: 'mock',
      timestamp: new Date().toISOString()
    });
  }
});

// Get specific trader details
router.get('/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // Try Substreams first
    let trader;
    try {
      trader = await substreamsService.getTraderDetails(address);
    } catch (substreamsError) {
      console.warn('Substreams unavailable for trader details:', substreamsError.message);
      
      // Fallback to database
      const { data, error } = await supabase
        .from('traders')
        .select(`
          *,
          users!inner(wallet_address, is_public)
        `)
        .eq('users.wallet_address', address.toLowerCase())
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Trader not found' });
      }

      trader = {
        address: data.users.wallet_address,
        winRate: data.win_rate,
        totalTrades: data.total_trades,
        profitLoss: data.profit_loss,
        totalVolume: data.total_volume,
        categories: data.categories || [],
        isPublic: data.users.is_public,
        tradeHistory: [], // Would need separate query
        categoryStats: data.category_stats || {}
      };
    }

    res.json(trader);

  } catch (error) {
    console.error('Trader details error:', error);
    res.status(500).json({ error: 'Failed to fetch trader details' });
  }
});

// Register trader as public (no auth required, wallet address in body)
router.post('/register', async (req, res) => {
  try {
    const { walletAddress, isPublic = true, categories = [] } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Create or update user
    const { data: user, error: userError } = await supabase
      .from('users')
      .upsert({ 
        wallet_address: walletAddress.toLowerCase(),
        is_public: isPublic 
      })
      .select()
      .single();

    if (userError) {
      console.error('User upsert error:', userError);
      return res.status(500).json({ error: 'Database error' });
    }

    // Create or update trader profile
    const { data: trader, error: traderError } = await supabase
      .from('traders')
      .upsert({
        user_id: user.id,
        categories: categories,
        updated_at: new Date()
      })
      .select()
      .single();

    if (traderError) {
      console.error('Trader upsert error:', traderError);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({
      message: 'Trader registered successfully',
      trader: {
        id: trader.id,
        address: walletAddress.toLowerCase(),
        isPublic: isPublic,
        categories: categories
      }
    });

  } catch (error) {
    console.error('Trader registration error:', error);
    res.status(500).json({ error: 'Failed to register trader' });
  }
});

// Get trader stats for specific address
router.get('/stats/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // Get trader stats
    let stats;
    try {
      stats = await substreamsService.getTraderDetails(address);
    } catch (substreamsError) {
      // Fallback to database
      const { data, error } = await supabase
        .from('traders')
        .select(`
          *,
          users!inner(wallet_address)
        `)
        .eq('users.wallet_address', address.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') { // Not found is OK
        throw error;
      }

      stats = data ? {
        address: address,
        winRate: data.win_rate || 0,
        totalTrades: data.total_trades || 0,
        profitLoss: data.profit_loss || 0,
        totalVolume: data.total_volume || 0,
        categories: data.categories || []
      } : {
        address: address,
        winRate: 0,
        totalTrades: 0,
        profitLoss: 0,
        totalVolume: 0,
        categories: []
      };
    }

    res.json(stats);

  } catch (error) {
    console.error('Trader stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;