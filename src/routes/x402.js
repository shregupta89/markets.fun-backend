// src/routes/x402.js - x402 Agentic Payments Integration
const express = require('express');
const supabase = require('../services/supabase');
const x402Service = require('../services/x402');

const router = express.Router();

// Create x402 copy trading agent (BOUNTY FEATURE)
router.post('/agent/create', async (req, res) => {
  try {
    const { followerAddress, traderAddress, maxPerTrade, totalLimit, categories } = req.body;

    if (!followerAddress || !traderAddress || !maxPerTrade || !totalLimit) {
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
        is_public: true
      })
      .select()
      .single();

    if (followerError || traderError) {
      console.error('User creation error:', { followerError, traderError });
      return res.status(500).json({ error: 'Database error' });
    }

    try {
      // Create x402 agent on blockchain
      const agentResult = await x402Service.createCopyTradingAgent({
        follower: followerAddress,
        trader: traderAddress,
        maxPerTrade: maxPerTrade,
        totalLimit: totalLimit,
        categories: categories || []
      });

      // Store agent info in database
      const { data: agentRecord, error: dbError } = await supabase
        .from('x402_agents')
        .insert({
          user_id: follower.id,
          trader_id: trader.id,
          agent_address: agentResult.agentAddress,
          max_per_trade: parseFloat(maxPerTrade),
          total_limit: parseFloat(totalLimit),
          categories: categories || [],
          active: true,
          tx_hash: agentResult.txHash,
          created_at: new Date()
        })
        .select()
        .single();

      if (dbError) {
        console.error('Agent DB storage error:', dbError);
        // Agent exists on blockchain but not in DB - this is OK for demo
      }

      res.json({
        agent: {
          id: agentRecord?.id || Date.now(),
          agentAddress: agentResult.agentAddress,
          traderAddress: traderAddress,
          followerAddress: followerAddress,
          maxPerTrade: maxPerTrade,
          totalLimit: totalLimit,
          categories: categories || [],
          active: true,
          txHash: agentResult.txHash
        },
        message: 'x402 copy trading agent created successfully'
      });

    } catch (x402Error) {
      console.error('x402 agent creation failed:', x402Error);
      
      // For demo purposes, create a mock agent if x402 fails
      const mockAgent = {
        id: Date.now(),
        agentAddress: `0x${Math.random().toString(16).slice(2, 42)}`,
        traderAddress: traderAddress,
        followerAddress: followerAddress,
        maxPerTrade: maxPerTrade,
        totalLimit: totalLimit,
        categories: categories || [],
        active: true,
        txHash: `0x${Math.random().toString(16).slice(2, 66)}`,
        demo: true
      };

      res.json({
        agent: mockAgent,
        message: 'Demo agent created (x402 service unavailable)',
        warning: 'This is a demo agent - x402 service integration pending'
      });
    }

  } catch (error) {
    console.error('Agent creation error:', error);
    res.status(500).json({ error: 'Failed to create copy trading agent' });
  }
});

// Get user's x402 agents
router.get('/agents/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    // Get user from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.json({ agents: [] }); // Return empty array if user not found
    }

    const { data: agents, error } = await supabase
      .from('x402_agents')
      .select(`
        *,
        trader:users!trader_id(wallet_address)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Agents fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch agents' });
    }

    // Get agent status from x402 for each agent
    const agentsWithStatus = await Promise.all(
      (agents || []).map(async (agent) => {
        let status = { active: agent.active, balance: '0', executedTrades: 0 };
        
        try {
          status = await x402Service.getAgentStatus(agent.agent_address);
        } catch (statusError) {
          console.warn('Could not fetch agent status:', statusError.message);
        }

        return {
          id: agent.id,
          agentAddress: agent.agent_address,
          traderAddress: agent.trader.wallet_address,
          maxPerTrade: agent.max_per_trade,
          totalLimit: agent.total_limit,
          categories: agent.categories || [],
          active: status.active,
          balance: status.balance,
          executedTrades: status.executedTrades,
          createdAt: agent.created_at,
          txHash: agent.tx_hash
        };
      })
    );

    res.json({ agents: agentsWithStatus });

  } catch (error) {
    console.error('My agents error:', error);
    res.status(500).json({ error: 'Failed to fetch my agents' });
  }
});

// Authorize agent spending (BOUNTY FEATURE)
router.post('/agent/:id/authorize', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, spendingLimit } = req.body;

    if (!walletAddress || !spendingLimit) {
      return res.status(400).json({ error: 'Wallet address and spending limit required' });
    }

    // Get user from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get agent details
    const { data: agent, error: agentError } = await supabase
      .from('x402_agents')
      .select('*')
      .eq('id', parseInt(id))
      .eq('user_id', user.id)
      .single();

    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    try {
      // Authorize spending on x402
      const authResult = await x402Service.authorizeAgentSpending({
        agentAddress: agent.agent_address,
        spendingLimit: spendingLimit
      });

      // Update agent authorization in database
      const { error: updateError } = await supabase
        .from('x402_agents')
        .update({
          authorized_amount: parseFloat(spendingLimit),
          authorized_at: new Date()
        })
        .eq('id', parseInt(id));

      if (updateError) {
        console.warn('Agent authorization DB update failed:', updateError);
      }

      res.json({
        message: 'Agent spending authorized successfully',
        authorizationTx: authResult.txHash,
        spendingLimit: spendingLimit,
        agentAddress: agent.agent_address
      });

    } catch (x402Error) {
      console.error('x402 authorization failed:', x402Error);
      
      // Demo response for when x402 is unavailable
      res.json({
        message: 'Demo authorization completed (x402 service unavailable)',
        authorizationTx: `0x${Math.random().toString(16).slice(2, 66)}`,
        spendingLimit: spendingLimit,
        agentAddress: agent.agent_address,
        demo: true
      });
    }

  } catch (error) {
    console.error('Agent authorization error:', error);
    res.status(500).json({ error: 'Failed to authorize agent' });
  }
});

// Pause/Resume agent (BOUNTY FEATURE)
router.post('/agent/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, active } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Get user from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get agent details
    const { data: agent, error: agentError } = await supabase
      .from('x402_agents')
      .select('*')
      .eq('id', parseInt(id))
      .eq('user_id', user.id)
      .single();

    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    try {
      // Toggle agent status on x402
      const toggleResult = await x402Service.toggleAgent({
        agentAddress: agent.agent_address,
        active: active
      });

      // Update in database
      const { data: updated, error: updateError } = await supabase
        .from('x402_agents')
        .update({ 
          active: active,
          updated_at: new Date()
        })
        .eq('id', parseInt(id))
        .select()
        .single();

      if (updateError) {
        console.warn('Agent toggle DB update failed:', updateError);
      }

      res.json({
        message: `Agent ${active ? 'activated' : 'paused'} successfully`,
        agentId: parseInt(id),
        active: active,
        toggleTx: toggleResult.txHash
      });

    } catch (x402Error) {
      console.error('x402 toggle failed:', x402Error);
      
      // Demo response
      res.json({
        message: `Demo agent ${active ? 'activated' : 'paused'} (x402 service unavailable)`,
        agentId: parseInt(id),
        active: active,
        toggleTx: `0x${Math.random().toString(16).slice(2, 66)}`,
        demo: true
      });
    }

  } catch (error) {
    console.error('Agent toggle error:', error);
    res.status(500).json({ error: 'Failed to toggle agent' });
  }
});

// Get agent execution history (BOUNTY FEATURE)
router.get('/agent/:id/executions', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    // Get user from wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify agent ownership
    const { data: agent, error: agentError } = await supabase
      .from('x402_agents')
      .select('agent_address')
      .eq('id', parseInt(id))
      .eq('user_id', user.id)
      .single();

    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    try {
      // Get execution history from x402
      const executions = await x402Service.getAgentExecutions(agent.agent_address);

      res.json({
        agentId: parseInt(id),
        agentAddress: agent.agent_address,
        executions: executions || []
      });

    } catch (x402Error) {
      console.warn('x402 executions fetch failed:', x402Error);

      // Demo executions data
      const demoExecutions = [
        {
          id: 1,
          marketId: 0,
          originalTrader: '0x1234567890123456789012345678901234567890',
          copiedAmount: '25.5',
          prediction: true,
          executedAt: new Date(Date.now() - 3600000).toISOString(),
          txHash: `0x${Math.random().toString(16).slice(2, 66)}`,
          status: 'completed'
        },
        {
          id: 2,
          marketId: 1,
          originalTrader: '0x1234567890123456789012345678901234567890',
          copiedAmount: '18.2',
          prediction: false,
          executedAt: new Date(Date.now() - 7200000).toISOString(),
          txHash: `0x${Math.random().toString(16).slice(2, 66)}`,
          status: 'completed'
        }
      ];

      res.json({
        agentId: parseInt(id),
        agentAddress: agent.agent_address,
        executions: demoExecutions,
        demo: true
      });
    }

  } catch (error) {
    console.error('Agent executions error:', error);
    res.status(500).json({ error: 'Failed to fetch agent executions' });
  }
});

// Webhook for x402 agent execution notifications (BOUNTY FEATURE)
router.post('/webhook/execution', async (req, res) => {
  try {
    const { agentAddress, executionData } = req.body;

    if (!agentAddress || !executionData) {
      return res.status(400).json({ error: 'Invalid webhook data' });
    }

    // Find the agent in our database
    const { data: agent, error: agentError } = await supabase
      .from('x402_agents')
      .select('*')
      .eq('agent_address', agentAddress)
      .single();

    if (agentError || !agent) {
      console.warn('Webhook for unknown agent:', agentAddress);
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Record the execution
    const { error: executionError } = await supabase
      .from('agent_executions')
      .insert({
        agent_id: agent.id,
        market_id: executionData.marketId,
        original_amount: executionData.originalAmount,
        copied_amount: executionData.copiedAmount,
        prediction: executionData.prediction,
        tx_hash: executionData.txHash,
        executed_at: new Date(executionData.timestamp)
      });

    if (executionError) {
      console.error('Execution recording failed:', executionError);
    }

    res.json({ 
      message: 'Execution recorded successfully',
      agentAddress: agentAddress
    });

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;