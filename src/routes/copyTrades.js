// src/routes/copyTrades.js
const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

// Create copy trading relationship (no auth required)
router.post('/', async (req, res) => {
  try {
    const { followerAddress, traderAddress, amount, categories, maxTrades } = req.body;

    if (!followerAddress || !traderAddress || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure both users exist
    const { data: follower, error: followerError } = await supabase
      .from('users')
      .upsert({ wallet_address: followerAddress.toLowerCase() })
      .select()
      .single();

    const { data: trader, error: traderError } = await supabase
      .from('users')
      .upsert({ 
        wallet_address: traderAddress.toLowerCase(),
        is_public: true // Assume they want to be public if someone is copying them
      })
      .select()
      .single();

    if (followerError || traderError) {
      console.error('User creation error:', { followerError, traderError });
      return res.status(500).json({ error: 'Database error' });
    }

    // Create copy trade relationship
    const { data: copyTrade, error } = await supabase
      .from('copy_trades')
      .insert({
        follower_id: follower.id,
        trader_id: trader.id,
        amount: parseFloat(amount),
        categories: categories || [],
        max_trades: maxTrades || null,
        active: true,
        created_at: new Date()
      })
      .select()
      .single();

    if (error) {
      console.error('Copy trade creation error:', error);
      return res.status(500).json({ error: 'Failed to create copy trade' });
    }

    res.json({
      copyTrade: {
        id: copyTrade.id,
        traderAddress: traderAddress.toLowerCase(),
        followerAddress: followerAddress.toLowerCase(),
        amount: copyTrade.amount,
        categories: copyTrade.categories,
        maxTrades: copyTrade.max_trades,
        active: copyTrade.active,
        createdAt: copyTrade.created_at
      }
    });

  } catch (error) {
    console.error('Copy trade creation error:', error);
    res.status(500).json({ error: 'Failed to create copy trade' });
  }
});

// Get user's copy trades
router.get('/user/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { type } = req.query; // 'following' or 'followers'

    let query;
    if (type === 'followers') {
      // Get people following this user
      query = supabase
        .from('copy_trades')
        .select(`
          *,
          follower:follower_id(wallet_address),
          trader:trader_id(wallet_address)
        `)
        .eq('trader_id', '(SELECT id FROM users WHERE wallet_address = $1)')
        .eq('active', true);
    } else {
      // Get who this user is following (default)
      query = supabase
        .from('copy_trades')
        .select(`
          *,
          follower:follower_id(wallet_address),
          trader:trader_id(wallet_address)
        `)
        .eq('follower_id', '(SELECT id FROM users WHERE wallet_address = $1)')
        .eq('active', true);
    }

    // For demo, let's use a simpler query
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', address.toLowerCase())
      .single();

    if (!user) {
      return res.json({ copyTrades: [] });
    }

    let finalQuery;
    if (type === 'followers') {
      finalQuery = supabase
        .from('copy_trades')
        .select(`
          *,
          follower:users!follower_id(wallet_address),
          trader:users!trader_id(wallet_address)
        `)
        .eq('trader_id', user.id)
        .eq('active', true);
    } else {
      finalQuery = supabase
        .from('copy_trades')
        .select(`
          *,
          follower:users!follower_id(wallet_address),
          trader:users!trader_id(wallet_address)
        `)
        .eq('follower_id', user.id)
        .eq('active', true);
    }

    const { data: copyTrades, error } = await finalQuery;

    if (error) {
      console.error('Copy trades fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch copy trades' });
    }

    const formattedTrades = (copyTrades || []).map(trade => ({
      id: trade.id,
      traderAddress: trade.trader?.wallet_address,
      followerAddress: trade.follower?.wallet_address,
      amount: trade.amount,
      categories: trade.categories || [],
      maxTrades: trade.max_trades,
      active: trade.active,
      createdAt: trade.created_at,
      executedTrades: trade.executed_trades || 0
    }));

    res.json({ copyTrades: formattedTrades });

  } catch (error) {
    console.error('Copy trades fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch copy trades' });
  }
});

// Update copy trade settings (no auth required, use wallet address)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, amount, categories, maxTrades, active } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Get user ID from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('copy_trades')
      .select('*')
      .eq('id', parseInt(id))
      .eq('follower_id', user.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Copy trade not found' });
    }

    // Update the copy trade
    const updates = {};
    if (amount !== undefined) updates.amount = parseFloat(amount);
    if (categories !== undefined) updates.categories = categories;
    if (maxTrades !== undefined) updates.max_trades = maxTrades;
    if (active !== undefined) updates.active = active;
    
    updates.updated_at = new Date();

    const { data: updated, error } = await supabase
      .from('copy_trades')
      .update(updates)
      .eq('id', parseInt(id))
      .select()
      .single();

    if (error) {
      console.error('Copy trade update error:', error);
      return res.status(500).json({ error: 'Failed to update copy trade' });
    }

    res.json({
      copyTrade: {
        id: updated.id,
        amount: updated.amount,
        categories: updated.categories,
        maxTrades: updated.max_trades,
        active: updated.active,
        updatedAt: updated.updated_at
      }
    });

  } catch (error) {
    console.error('Copy trade update error:', error);
    res.status(500).json({ error: 'Failed to update copy trade' });
  }
});

// Stop copy trading (no auth required, use wallet address)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Get user ID from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify ownership and deactivate
    const { data: updated, error } = await supabase
      .from('copy_trades')
      .update({ 
        active: false,
        updated_at: new Date()
      })
      .eq('id', parseInt(id))
      .eq('follower_id', user.id)
      .select()
      .single();

    if (error || !updated) {
      return res.status(404).json({ error: 'Copy trade not found' });
    }

    res.json({ 
      message: 'Copy trading stopped successfully',
      copyTradeId: updated.id
    });

  } catch (error) {
    console.error('Copy trade deletion error:', error);
    res.status(500).json({ error: 'Failed to stop copy trading' });
  }
});

// Get copy trade execution history (no auth required, use wallet address)
router.get('/:id/executions', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Get user ID from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify ownership
    const { data: copyTrade, error: copyTradeError } = await supabase
      .from('copy_trades')
      .select('*')
      .eq('id', parseInt(id))
      .eq('follower_id', user.id)
      .single();

    if (copyTradeError || !copyTrade) {
      return res.status(404).json({ error: 'Copy trade not found' });
    }

    // Get execution history
    const { data: executions, error } = await supabase
      .from('copy_trade_executions')
      .select(`
        *,
        market:markets(question, category),
        original_trade:trades(amount, prediction)
      `)
      .eq('copy_trade_id', parseInt(id))
      .order('executed_at', { ascending: false });

    if (error) {
      console.error('Executions fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch executions' });
    }

    res.json({ 
      executions: executions || [],
      copyTradeId: parseInt(id)
    });

  } catch (error) {
    console.error('Executions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

module.exports = router;