import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './App.css';
import ForceGraph2D from 'react-force-graph-2d';
import * as d3 from 'd3';

class CypherViz extends React.Component {
  constructor({ driver }) {
    super();
    this.driver = driver;
    this.fgRef = React.createRef();
    
    this.defaultData = {
      nodes: [],
      links: []
    };
    
    this.state = {
      data: this.defaultData,
      query: `MATCH (u:User)-[r:CONNECTED_TO]->(v:User) 
          RETURN u.name AS source, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite, 
      v.name AS target, v.role AS targetRole, v.location AS targetLocation, v.website AS targetWebsite`,
      latestNode: null, // For NFC editing
      pollingFocusNode: null, // For polling focus (non-editable)
      lastUpdateTime: null,
      isPolling: false,
      useWebSocket: false,
      wsConnected: false,
      customQueryActive: false,
      customQueryTimeout: null,
      processingMutation: false,
      lastUserActivity: Date.now(),
      isUserActive: true,
      nfcNodeForAutoPopup: null, // For auto-popup form on NFC tap

    };

    // Store the default query for polling (separate from user input)
    this.defaultQuery = `MATCH (u:User)-[r:CONNECTED_TO]->(v:User) 
        RETURN u.name AS source, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite, 
        v.name AS target, v.role AS targetRole, v.location AS targetLocation, v.website AS targetWebsite`;

    // Store the last known data hash for change detection
    this.lastDataHash = null;
    this.pollingInterval = null;
    this.websocket = null;
    this.lastUpdateTime = 0;
    this.updateDebounceTime = 2000; // 2 seconds debounce
    this.updateCount = 0;
    this.maxUpdatesPerCycle = 3; // Prevent infinite loops
    this.mutationReloadTimeout = null;
    this.idleTimeout = null;
    this.idleCheckInterval = null;
    this.isNFCOperation = false; // Flag to prevent double reload during NFC operations
    this.changedNodesFromPolling = []; // Track nodes changed during polling
    this.isInitialLoad = true; // Flag to prevent focusing on initial load
    this.pollingFocusTimeout = null; // Timeout to clear polling focus
    this.breathingAnimation = null; // For breathing animation
    this.breathingState = 'expanded'; // 'contracted' or 'expanded'
    this.breathingInterval = null; // Interval for breathing cycle
    this.scaleTransitionStart = null; // For smooth scaling transition
    this.scaleTransitionDuration = 1000; // 1 second transition

  }

  // Breathing animation methods
  startBreathingAnimation = () => {
    if (this.breathingInterval) {
      clearInterval(this.breathingInterval);
    }
    
    // Start breathing cycle every 4 seconds
    this.breathingInterval = setInterval(() => {
      if (!this.state.isUserActive && this.fgRef.current) {
        this.triggerBreathingCycle();
      }
    }, 4000); // 4 second cycle
  };

  stopBreathingAnimation = () => {
    if (this.breathingInterval) {
      clearInterval(this.breathingInterval);
      this.breathingInterval = null;
    }
    
    // Reset to expanded state when stopping and clean up forces
    if (this.fgRef.current && this.breathingState === 'contracted') {
      this.expandNodes();
    }
  };

  triggerBreathingCycle = () => {
    if (this.breathingState === 'expanded') {
      this.contractNodes();
    } else {
      this.expandNodes();
    }
  };

  contractNodes = () => {
    if (!this.fgRef.current) return;
    
    this.breathingState = 'contracted';
    
    // Get the current graph instance
    const graph = this.fgRef.current;
    
    // Start with very low strength and gradually increase for smooth transition
    let currentStrength = 0.01;
    const targetStrength = 0.05;
    const rampDuration = 2000; // 2 seconds to ramp up
    const rampSteps = 20;
    const strengthIncrement = (targetStrength - currentStrength) / rampSteps;
    const stepInterval = rampDuration / rampSteps;
    
    const rampUpForce = () => {
      if (currentStrength < targetStrength) {
        currentStrength += strengthIncrement;
        graph.d3Force('breathing-attraction', d3.forceRadial(0, 0, 10).strength(currentStrength));
        graph.d3ReheatSimulation();
        setTimeout(rampUpForce, stepInterval);
      }
    };
    
    // Start the gradual ramp-up
    rampUpForce();
    
    // After 10 seconds, expand back (5x slower)
    setTimeout(() => {
      this.expandNodes();
    }, 10000);
  };

  expandNodes = () => {
    if (!this.fgRef.current) return;
    
    this.breathingState = 'expanded';
    
    // Get the current graph instance
    const graph = this.fgRef.current;
    
    // Gradually reduce the breathing force for smooth expansion
    const currentForce = graph.d3Force('breathing-attraction');
    if (currentForce) {
      let currentStrength = 0.05;
      const rampDuration = 2000; // 2 seconds to ramp down
      const rampSteps = 20;
      const strengthDecrement = currentStrength / rampSteps;
      const stepInterval = rampDuration / rampSteps;
      
      const rampDownForce = () => {
        if (currentStrength > 0.001) {
          currentStrength -= strengthDecrement;
          graph.d3Force('breathing-attraction', d3.forceRadial(0, 0, 10).strength(currentStrength));
          graph.d3ReheatSimulation();
          setTimeout(rampDownForce, stepInterval);
        } else {
          // Completely remove the force when it's very small
          graph.d3Force('breathing-attraction', null);
          graph.d3ReheatSimulation();
        }
      };
      
      // Start the gradual ramp-down
      rampDownForce();
    }
  };

  // Update user activity timestamp
  updateUserActivity = () => {
    const now = Date.now();
    const wasActive = this.state.isUserActive;
    
    this.setState({ 
      lastUserActivity: now,
      isUserActive: true 
    });
    
    // If user just became active, stop breathing animation and start scale transition immediately
    if (!wasActive) {
      this.stopBreathingAnimation();
      // Capture the exact breathing state at this moment to prevent jitter
      this.scaleTransitionStart = now;
      // Force an immediate re-render to start the transition
      this.forceUpdate();
    }
    
    // Clear existing idle timeout
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
    }
    
    // Set new idle timeout (5 seconds of inactivity)
    this.idleTimeout = setTimeout(() => {
      this.setState({ isUserActive: false });
      // Start breathing animation when user becomes idle
      this.startBreathingAnimation();
    }, 5000); // 5 seconds of inactivity
  };

  // Check if user is idle and should return to default query
  checkIdleAndReturnToDefault = () => {
    // Don't interfere if a mutation is being processed
    if (this.state.processingMutation) {
      return;
    }
    
    if (this.state.customQueryActive && !this.state.isUserActive) {
      this.setState({ 
        customQueryActive: false, 
        customQueryTimeout: null 
      });
      
      // Clear any existing timeout
      if (this.state.customQueryTimeout) {
        clearTimeout(this.state.customQueryTimeout);
      }
      
      // Reload with default query
      this.loadData(null, this.defaultQuery);
    }
  };

  // Start idle detection system
  startIdleDetection = () => {
    // Set up activity listeners
    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    activityEvents.forEach(event => {
      document.addEventListener(event, this.updateUserActivity, true);
    });
    
    // Check for idle state every 2 seconds
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleAndReturnToDefault();
    }, 2000);
    
    // Initial activity update
    this.updateUserActivity();
  };

  // Stop idle detection
  stopIdleDetection = () => {
    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    activityEvents.forEach(event => {
      document.removeEventListener(event, this.updateUserActivity, true);
    });
    
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  };

  loadData = async (newNodeName = null, queryOverride = null) => {

    let session = this.driver.session({ database: "neo4j" });
    let res;
    
    // Determine which query to use
    let queryToExecute = queryOverride;
    let isCustomQuery = false;
    
    if (!queryToExecute) {
      // For polling, use default query unless a custom query is active
      if (newNodeName === null && !queryOverride && !this.state.customQueryActive) {
        queryToExecute = this.defaultQuery;
      } else {
        // For user-initiated queries, use state.query but validate it
        queryToExecute = this.state.query;
        isCustomQuery = true;
      }
    } else if (queryOverride !== this.defaultQuery) {
      // If a custom query is being executed
      isCustomQuery = true;
    }
    
    // Special handling for NFC operations - if we have a pending NFC node, 
    // we should use the default query to reload the graph after mutation
    if (newNodeName && this.pendingNFCNode && newNodeName === this.pendingNFCNode) {
      queryToExecute = this.defaultQuery;
      isCustomQuery = false;
    }
    

    
    // Check if this is a mutation query BEFORE determining if it's custom
    const isMutationQuery = /(CREATE|MERGE|SET|DELETE|REMOVE|DETACH DELETE)/i.test(queryToExecute.trim());
    
    // If it's a mutation query, it should never be treated as a custom query
    if (isMutationQuery) {
      isCustomQuery = false;
    }
    
    // Validate the query
    if (!queryToExecute || typeof queryToExecute !== 'string' || queryToExecute.trim() === '') {
      console.error("Invalid query:", queryToExecute);
      return;
    }
    
    // Check if query starts with valid Cypher keywords
    const validStartKeywords = ['MATCH', 'CREATE', 'MERGE', 'DELETE', 'SET', 'RETURN', 'WITH', 'UNWIND', 'CALL'];
    const queryStart = queryToExecute.trim().toUpperCase();
    const isValidQuery = validStartKeywords.some(keyword => queryStart.startsWith(keyword));
    
    if (!isValidQuery) {
      return;
    }
    
    try {
  
              res = await session.run(queryToExecute);
      
              // Handle mutations for ALL queries (not just custom ones)
        if (isMutationQuery) {
        // For mutation queries, immediately return to default query
        
        // Force return to default state regardless of idle detection
        this.setState({ 
          customQueryActive: false, 
          customQueryTimeout: null,
          processingMutation: true,
          isUserActive: true // Temporarily mark as active to prevent idle interference
        });
        
        // Clear any existing timeout
        if (this.state.customQueryTimeout) {
          clearTimeout(this.state.customQueryTimeout);
        }
        
        // Prevent multiple mutation reloads
        if (this.mutationReloadTimeout) {
          clearTimeout(this.mutationReloadTimeout);
        }
        
        // Store the pending NFC node before reloading
        const pendingNode = this.pendingNFCNode;
        
        // For NFC operations, don't trigger another reload since addNodeNFC already handles it
        if (this.isNFCOperation) {
          // Skip additional reload for NFC operations
        } else if (!this.state.processingMutation) {
          // Immediately reload with default query to show updated graph
          this.loadData(pendingNode, this.defaultQuery);
        }
        
        this.setState({ processingMutation: false });
        this.mutationReloadTimeout = null;
        
        // For NFC operations, focusing is handled in addNodeNFC, so skip here
        if (pendingNode && !this.isNFCOperation) {
          setTimeout(() => {
            this.focusOnNewNode(pendingNode, this.state.data);
            this.pendingNFCNode = null;
          }, 1500);
        } else if (this.isNFCOperation) {
          // NFC operation - focusing will be handled by addNodeNFC
        } else {
          // Reset NFC operation flag if no pending node
          this.isNFCOperation = false;
        }
        
        // Reset user activity state after a short delay to allow idle detection to work normally
        setTimeout(() => {
          this.updateUserActivity();
        }, 100);
        
        // Return early to prevent processing mutation query results
        return;
      } else if (isCustomQuery) {
        // For non-mutation custom queries, activate custom query state
        this.setState({ customQueryActive: true });
        
        // Clear any existing timeout
        if (this.state.customQueryTimeout) {
          clearTimeout(this.state.customQueryTimeout);
        }
        
        // Update user activity to reset idle timer
        this.updateUserActivity();
      }
    } catch (err) {
      console.error("Neo4j query failed:", err);
      console.error("Query was:", queryToExecute);
      this.setState({ data: { nodes: [], links: [] } });
      return;
    } finally {
      session.close();
    }


    let nodesMap = new Map();
    let links = [];

    // Intelligent parser
    res.records.forEach((record) => {
      if (record.has("source") && record.has("target") && record.get("source") && record.get("target") && 
          typeof record.get("source") === 'string' && typeof record.get("target") === 'string') {
        // standard case
        let source = record.get("source");
        let target = record.get("target");

        if (!nodesMap.has(source)) {
          nodesMap.set(source, {
            name: source,
            role: record.get("sourceRole"),
            location: record.get("sourceLocation"),
            website: record.get("sourceWebsite"),
            x: Math.random() * 500,
            y: Math.random() * 500,
          });
        }

        if (!nodesMap.has(target)) {
          nodesMap.set(target, {
            name: target,
            role: record.get("targetRole"),
            location: record.get("targetLocation"),
            website: record.get("targetWebsite"),
            x: Math.random() * 500,
            y: Math.random() * 500,
          });
        }

        if (nodesMap.has(source) && nodesMap.has(target)) {
          links.push({ source, target });
        } else {
  console.warn("Invalid link skipped:", { source, target });
}
      } else {
        // fallback: node-only query
        record.keys.forEach((key) => {
          const node = record.get(key);
          if (node && node.properties && node.identity) {
            const name = node.properties.name || `Node-${node.identity.low}`;
            if (!nodesMap.has(name)) {
              nodesMap.set(name, {
                name,
                role: node.properties.role || "",
                location: node.properties.location || "",
                website: node.properties.website || "",
                x: Math.random() * 500,
                y: Math.random() * 500,
              });
            }
          } else if (node && typeof node === 'object') {
            // Handle SET query results that might have different structure
            const name = node.name || node.u_name || `Node-${Date.now()}`;
            if (!nodesMap.has(name)) {
              nodesMap.set(name, {
                name,
                role: node.role || node.u_role || "",
                location: node.location || node.u_location || "",
                website: node.website || node.u_website || "",
                x: Math.random() * 500,
                y: Math.random() * 500,
              });
            }
          } else if (typeof node === 'string' && key.includes('name')) {
            // Handle direct string values from queries like RETURN u.name, u.role
            const name = node;
            if (!nodesMap.has(name)) {
              nodesMap.set(name, {
                name,
                role: record.get(key.replace('name', 'role')) || "",
                location: record.get(key.replace('name', 'location')) || "",
                website: record.get(key.replace('name', 'website')) || "",
                x: Math.random() * 500,
                y: Math.random() * 500,
              });
            }
          }
        });
      }
    });

    const nodes = Array.from(nodesMap.values());
    const updatedData = { nodes, links };
    
    // Check if our NFC node is in the parsed results
    if (this.pendingNFCNode) {
      const nfcNodeInResults = nodes.find(n => n.name === this.pendingNFCNode);
    }

    // Calculate hash of current data for change detection
    const currentDataHash = this.calculateDataHash(updatedData);
    const hasChanged = this.lastDataHash !== currentDataHash;
    
    // Also use more detailed change detection (but not during initial load)
    const hasDetailedChange = this.isInitialLoad ? false : this.hasDataChanged(updatedData, this.state.data);
    
    // Additional check: if the data is exactly the same, don't update
    const isDataIdentical = JSON.stringify(updatedData) === JSON.stringify(this.state.data);
    

    


    localStorage.setItem("graphData", JSON.stringify(updatedData));
    
    // Only update state if there's a change or if it's the initial load
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    
    // Force update if we have a newNodeName (NFC operation) regardless of debounce
    const forceUpdateForNFC = newNodeName && this.pendingNFCNode && newNodeName === this.pendingNFCNode;
    
    if ((hasChanged || hasDetailedChange || this.lastDataHash === null || forceUpdateForNFC) && 
        !isDataIdentical &&
        (timeSinceLastUpdate > this.updateDebounceTime || this.lastDataHash === null || forceUpdateForNFC) &&
        this.updateCount < this.maxUpdatesPerCycle) {
      // Update the hash only when we actually update the state
      this.lastDataHash = currentDataHash;
      this.lastUpdateTime = now;
      this.updateCount++;
      
      // Mark initial load as complete after first successful update
      if (this.isInitialLoad) {
        this.isInitialLoad = false;
      }
      
      // Preserve latestNode if newNodeName is null but we have a valid latestNode
      // Don't set latestNode during initial load
      const nodeToSet = this.isInitialLoad ? null : (newNodeName || this.state.latestNode);
      this.setState({ 
        data: updatedData, 
        latestNode: nodeToSet,
        lastUpdateTime: hasChanged ? now : this.state.lastUpdateTime
      }, () => {
      if (newNodeName) {
        // Focus on the new node with multiple attempts to ensure it works (NFC editing)
        this.focusOnNewNode(newNodeName, updatedData);
      } else if (this.changedNodesFromPolling.length > 0 && !this.isInitialLoad) {
        // Focus on the first changed node from polling (but not on initial load) - non-editable
        const firstChangedNode = this.changedNodesFromPolling[0];
        this.focusOnPollingNode(firstChangedNode, updatedData);
        
        // Set a 10-second timeout to clear the focus
        if (this.pollingFocusTimeout) {
          clearTimeout(this.pollingFocusTimeout);
        }
        this.pollingFocusTimeout = setTimeout(() => {
          this.setState({ pollingFocusNode: null });
          this.pollingFocusTimeout = null;
        }, 10000); // 10 seconds
        
        // Clear the changed nodes list after focusing
        this.changedNodesFromPolling = [];
      }
    });
    } else {
      // Even if no change, we might need to update latestNode for new additions
      if (newNodeName && this.state.latestNode !== newNodeName) {
        this.setState({ latestNode: newNodeName });
      }
      // Reset update count when no changes are detected
      this.updateCount = 0;
    }
  };

    // Focus on a newly added node with multiple attempts
  focusOnNewNode = (nodeName, graphData) => {
    
    const attemptFocus = (attempt = 1) => {
      if (attempt > 5) {
        return;
      }

      const newNode = graphData.nodes.find((n) => n.name === nodeName);
      if (!newNode) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
        return;
      }

      if (!this.fgRef.current) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
        return;
      }

      try {
            this.fgRef.current.centerAt(newNode.x, newNode.y, 1500);
            this.fgRef.current.zoom(1.25);
        
        // Also ensure the latestNode state is set
        this.setState({ latestNode: nodeName });
      } catch (error) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
      }
    };

    // Start with a longer delay for the first attempt to ensure graph is rendered
    setTimeout(() => attemptFocus(1), 1000);
  };

  // Focus on polling changes (non-editable - sets pollingFocusNode)
  focusOnPollingNode = (nodeName, graphData) => {
    
    const attemptFocus = (attempt = 1) => {
      if (attempt > 5) {
        return;
      }

      const newNode = graphData.nodes.find((n) => n.name === nodeName);
      if (!newNode) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
        return;
      }

      if (!this.fgRef.current) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
        return;
      }

      try {
        this.fgRef.current.centerAt(newNode.x, newNode.y, 1500);
        this.fgRef.current.zoom(1.25);
        
        // Set pollingFocusNode (non-editable)
        this.setState({ pollingFocusNode: nodeName });
      } catch (error) {
        setTimeout(() => attemptFocus(attempt + 1), 500);
      }
    };

    // Start with a longer delay for the first attempt to ensure graph is rendered
    setTimeout(() => attemptFocus(1), 1000);
  };

  // Focus on multiple nodes (for future use)
  focusOnMultipleNodes = (nodeNames, graphData) => {
    if (!nodeNames || nodeNames.length === 0) return;
    
    // For now, focus on the first node
    // In the future, this could calculate a bounding box of all nodes
    this.focusOnNewNode(nodeNames[0], graphData);
  };

  // Calculate a simple hash of the graph data for change detection
  calculateDataHash = (data) => {
    // Only hash the actual data, not the random coordinates
    const nodesStr = data.nodes.map(n => `${n.name}:${n.role}:${n.location}:${n.website}`).sort().join('|');
    const linksStr = data.links.map(l => {
      const source = typeof l.source === 'object' ? l.source.name : l.source;
      const target = typeof l.target === 'object' ? l.target.name : l.target;
      return `${source}:${target}`;
    }).sort().join('|');
    return `${nodesStr}|${linksStr}`;
  };

  // More detailed change detection with change tracking
  hasDataChanged = (newData, oldData) => {
    if (!oldData || !oldData.nodes || !oldData.links) return true;
    
    let changedNodes = [];
    let hasChanges = false;
    
    // Check if number of nodes or links changed
    if (newData.nodes.length !== oldData.nodes.length || 
        newData.links.length !== oldData.links.length) {
      hasChanges = true;
    }
    
    // Check if any node properties changed
    const oldNodesMap = new Map(oldData.nodes.map(n => [n.name, n]));
    for (const newNode of newData.nodes) {
      const oldNode = oldNodesMap.get(newNode.name);
      if (!oldNode) {
        // New node added
        changedNodes.push(newNode.name);
        hasChanges = true;
      } else if (oldNode.role !== newNode.role || 
                 oldNode.location !== newNode.location || 
                 oldNode.website !== newNode.website) {
        // Existing node modified
        changedNodes.push(newNode.name);
        hasChanges = true;
      }
    }
    
    // Check if any links changed
    const oldLinksSet = new Set(oldData.links.map(l => {
      const source = typeof l.source === 'object' ? l.source.name : l.source;
      const target = typeof l.target === 'object' ? l.target.name : l.target;
      return `${source}:${target}`;
    }));
    
    for (const newLink of newData.links) {
      const source = typeof newLink.source === 'object' ? newLink.source.name : newLink.source;
      const target = typeof newLink.target === 'object' ? newLink.target.name : newLink.target;
      if (!oldLinksSet.has(`${source}:${target}`)) {
        // New link added - focus on both source and target nodes
        if (!changedNodes.includes(source)) changedNodes.push(source);
        if (!changedNodes.includes(target)) changedNodes.push(target);
        hasChanges = true;
      }
    }
    
    // Store changed nodes for focusing
    if (hasChanges && changedNodes.length > 0) {
      this.changedNodesFromPolling = changedNodes;
    }
    
    return hasChanges;
  };

  // Start polling for changes
  startPolling = () => {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    this.setState({ isPolling: true });
    this.pollingInterval = setInterval(() => {
      // Only poll if the tab is active (to save resources)
      if (!document.hidden) {
        // Use default query for polling, but respect custom query state, mutation processing, and NFC operations
        if (this.state.customQueryActive || this.state.processingMutation || this.isNFCOperation) {
          return;
        }
        // Don't preserve latestNode during polling - let change detection determine focus
        this.loadData(null, this.defaultQuery);
      }
    }, 5000); // Check every 5 seconds
    
    // Reset update count every 30 seconds to prevent permanent blocking
    if (this.updateCountResetInterval) {
      clearInterval(this.updateCountResetInterval);
    }
    this.updateCountResetInterval = setInterval(() => {
      this.updateCount = 0;
    }, 30000);
  };

  // Stop polling
  stopPolling = () => {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.updateCountResetInterval) {
      clearInterval(this.updateCountResetInterval);
      this.updateCountResetInterval = null;
    }
    this.setState({ isPolling: false });
  };

  // WebSocket methods for real-time updates (disabled for now)
  connectWebSocket = () => {
    // WebSocket is disabled - using polling instead
    // Uncomment and configure when WebSocket server is available
    /*
    try {
      this.websocket = new WebSocket('wss://your-websocket-server.com');
      
      this.websocket.onopen = () => {
        this.setState({ wsConnected: true, useWebSocket: true });
      };
      
      this.websocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'graph_update') {
          this.loadData(null, this.defaultQuery);
        }
      };
      
      this.websocket.onclose = () => {
        this.setState({ wsConnected: false });
        setTimeout(() => {
          if (!this.state.isPolling) {
            this.startPolling();
          }
        }, 5000);
      };
      
      this.websocket.onerror = (error) => {
        this.setState({ wsConnected: false });
      };
    } catch (error) {
      this.startPolling();
    }
    */
    
    // Start polling directly since WebSocket is disabled
    this.startPolling();
  };

  disconnectWebSocket = () => {
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    this.setState({ wsConnected: false, useWebSocket: false });
  };

  // Enhanced componentDidMount to start polling directly
  componentDidMount() {
    // Validate and clean the query state first
    this.validateAndCleanQuery();
    
    this.loadData();
    
    // Start polling (WebSocket is disabled)
    this.connectWebSocket();
    
    // Add visibility change listener to pause polling when tab is not active
    this.handleVisibilityChange = () => {
      // Tab visibility change handling
    };
    
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    
    // Start idle detection
    this.startIdleDetection();
  }

  componentWillUnmount() {
    // Clean up both polling and WebSocket
    this.stopPolling();
    this.disconnectWebSocket();
    
    // Clear custom query timeout
    if (this.state.customQueryTimeout) {
      clearTimeout(this.state.customQueryTimeout);
    }
    
    // Clear mutation reload timeout
    if (this.mutationReloadTimeout) {
      clearTimeout(this.mutationReloadTimeout);
      this.mutationReloadTimeout = null;
    }
    
    // Clear processing mutation state
    this.setState({ processingMutation: false });
    
    // Clear polling focus timeout
    if (this.pollingFocusTimeout) {
      clearTimeout(this.pollingFocusTimeout);
      this.pollingFocusTimeout = null;
    }
    
    // Stop breathing animation
    this.stopBreathingAnimation();
    
    // Stop idle detection
    this.stopIdleDetection();
    
    // Remove visibility change listener
    if (this.handleVisibilityChange) {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  addNodeNFC = async (newUser, nfcUserName) => {
    // Helper function to capitalize first letter of each word
    const capitalizeWords = (str) => {
      if (!str) return str;
      return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    };

    const capitalizedNewUser = capitalizeWords(newUser);

    // Set NFC operation flag to prevent double reload
    this.isNFCOperation = true;

    // Clear any existing pending NFC node to prevent conflicts
    if (this.pendingNFCNode) {
      this.pendingNFCNode = null;
    }

    let session = this.driver.session({ database: "neo4j" });
    try {
      await session.run(
        `MERGE (u:User {name: $user}) 
         ON CREATE SET u.role = 'Affiliate', 
                       u.location = '', 
                       u.website = ''

         MERGE (nfc:User {name: $nfcUser}) 
         ON CREATE SET nfc.role = 'Holder', 
                       nfc.location = '', 
                       nfc.website = ''

         MERGE (awu:User {name: $awuUser}) 

         MERGE (u)-[:CONNECTED_TO]->(nfc) 
        MERGE (nfc)-[:CONNECTED_TO]->(awu)`,
        { 
          user: capitalizedNewUser, 
          nfcUser: capitalizeWords(nfcUserName), 
          awuUser: "Awu Chen" 
        }
        );
      
      // Store the new user name for focusing after mutation completes
      this.pendingNFCNode = capitalizedNewUser;
      
      // Trigger a single loadData call to reload the graph with the new node
      await this.loadData(capitalizedNewUser, this.defaultQuery);
      
      // Wait for the state to be updated, then focus and auto-popup form
      let checkCount = 0;
      const waitForStateUpdate = () => {
        const nodeExists = this.state.data.nodes.find(n => n.name === capitalizedNewUser);
        checkCount++;
        
        if (nodeExists) {
          this.focusOnNewNode(capitalizedNewUser, this.state.data);
          this.pendingNFCNode = null;
          this.isNFCOperation = false;
          
          // Auto-popup the form for the new NFC node
          // We'll trigger this by setting the node as selected and edited
          // This will be handled in the GraphView component
          this.setState({ 
            nfcNodeForAutoPopup: capitalizedNewUser 
          });
        } else {
          setTimeout(waitForStateUpdate, 500);
        }
      };
      
      // Start checking for state update after a short delay
      setTimeout(waitForStateUpdate, 1000);
      
      // Old focusing logic removed - replaced with state-aware focusing above
    } catch (error) {
      console.error("Error adding user:", error);
    } finally {
      session.close();
    }
  };

  handleChange = (event) => {
    // Only update the query state if it's a valid Cypher query or empty
    const newQuery = event.target.value;
    
    // Allow empty queries (for clearing)
    if (!newQuery || newQuery.trim() === '') {
      this.setState({ query: this.defaultQuery });
      return;
    }
    
    // Check if it starts with valid Cypher keywords
    const validStartKeywords = ['MATCH', 'CREATE', 'MERGE', 'DELETE', 'SET', 'RETURN', 'WITH', 'UNWIND', 'CALL'];
    const queryStart = newQuery.trim().toUpperCase();
    const isValidQuery = validStartKeywords.some(keyword => queryStart.startsWith(keyword));
    
    if (isValidQuery) {
      this.setState({ query: newQuery });
    }
  };

  // Method to reset query to default
  resetQuery = () => {
    this.setState({ 
      query: this.defaultQuery,
      customQueryActive: false,
      customQueryTimeout: null,
      processingMutation: false
    });
    
    // Clear any existing timeout
    if (this.state.customQueryTimeout) {
      clearTimeout(this.state.customQueryTimeout);
    }
  };

  // Method to validate and clean the current query state
  validateAndCleanQuery = () => {
    const currentQuery = this.state.query;
    
    // Check if current query is valid
    if (!currentQuery || typeof currentQuery !== 'string' || currentQuery.trim() === '') {
      this.setState({ query: this.defaultQuery });
      return;
    }
    
    // Check if it starts with valid Cypher keywords
    const validStartKeywords = ['MATCH', 'CREATE', 'MERGE', 'DELETE', 'SET', 'RETURN', 'WITH', 'UNWIND', 'CALL'];
    const queryStart = currentQuery.trim().toUpperCase();
    const isValidQuery = validStartKeywords.some(keyword => queryStart.startsWith(keyword));
    
    if (!isValidQuery) {
      this.setState({ query: this.defaultQuery });
    }
  };

  // Callback to clear NFC popup trigger
  onNfcPopupTriggered = () => {
    this.setState({ nfcNodeForAutoPopup: null });
  };

  render() {
    return (
      <Router>
      <div>
      <Routes>
      <Route path="/:username" element={<NFCTrigger addNode={this.addNodeNFC} />} />
      <Route path="/" element={
        <GraphView 
        data={this.state.data} 
        handleChange={this.handleChange} 
        loadData={this.loadData} 
        fgRef={this.fgRef} 
        latestNode={this.state.latestNode} 
        pollingFocusNode={this.state.pollingFocusNode}
    driver={this.driver} // Pass the driver
        processingMutation={this.state.processingMutation}
        updateUserActivity={this.updateUserActivity}
        isUserActive={this.state.isUserActive}
        scaleTransitionStart={this.scaleTransitionStart}
        scaleTransitionDuration={this.scaleTransitionDuration}
        nfcNodeForAutoPopup={this.state.nfcNodeForAutoPopup}
        onNfcPopupTriggered={this.onNfcPopupTriggered}
    />
  } />
  </Routes>
  

  </div>
  </Router>
  );
}
}

const NFCTrigger = ({ addNode }) => {
  const location = useLocation();
  const { username } = useParams();

  React.useEffect(() => {
    const addAndRedirect = async () => {
      const newUser = `User-${Date.now()}`;
      console.log(`NFC Trigger: Starting NFC operation for ${username} with new user ${newUser}`);

      try {
        await addNode(newUser, username); // pass dynamic user
        console.log(`NFC Trigger: addNode completed successfully`);
        } catch (error) {
          console.error("NFC Trigger: Error adding user:", error);
          return;
        }

        setTimeout(() => {
          window.location.assign("/GreifNet/#/");
          }, 2000);
        };

        addAndRedirect();
        }, [location, username]);

        return <div style={{ textAlign: "center", padding: "20px", fontSize: "16px", color: "red" }}>Adding you to {username}'s network...</div>
      };

              const GraphView = ({ data, handleChange, loadData, fgRef, latestNode, pollingFocusNode, driver, processingMutation, updateUserActivity, isUserActive, scaleTransitionStart, scaleTransitionDuration, nfcNodeForAutoPopup, onNfcPopupTriggered }) => {
        const [inputValue, setInputValue] = useState(""); 
        const [selectedNode, setSelectedNode] = useState(null);
        const [editedNode, setEditedNode] = useState(null);
        const [focusNode, setFocusNode] = useState(null);
        const [clickedNode, setClickedNode] = useState(null);
        const [lastAction, setLastAction] = useState(null); // 'search', 'click', 'latestNode', or 'mutation'
        const [mutatedNodes, setMutatedNodes] = useState([]); // Track nodes created/modified by mutation queries
        const [analyticalAnswer, setAnalyticalAnswer] = useState(null); // For displaying analytical answers
        const [showAnalyticalModal, setShowAnalyticalModal] = useState(false); // For showing/hiding the answer modal

        // Detect when latestNode changes (NFC addition) and set lastAction
        useEffect(() => {
          if (latestNode) {
            setLastAction('latestNode');
          }
        }, [latestNode]);

        // Auto-popup form for NFC nodes
        useEffect(() => {
          if (nfcNodeForAutoPopup && data.nodes.length > 0) {
            // Find the NFC node in the data
            const nfcNode = data.nodes.find(node => node.name === nfcNodeForAutoPopup);
            if (nfcNode) {
              // Set the node as selected and edited to trigger the form popup
              setSelectedNode(nfcNode);
              setEditedNode({ ...nfcNode });
              setFocusNode(nfcNode.name);
              setClickedNode(nfcNode.name);
              setLastAction('latestNode');
              
              // Clear the nfcNodeForAutoPopup after triggering the popup
              // We'll need to pass a callback to clear this state
              if (typeof onNfcPopupTriggered === 'function') {
                onNfcPopupTriggered();
              }
            }
          }
        }, [nfcNodeForAutoPopup, data.nodes]);

        // Initial zoom when graph first loads
        useEffect(() => {
          if (fgRef.current && data.nodes.length > 0 && !lastAction) {
            // Wait a bit for the graph to settle, then zoom to 2x
            setTimeout(() => {
              if (fgRef.current) {
                fgRef.current.zoom(2, 1000);
              }
            }, 1000);
          }
        }, [data.nodes, fgRef, lastAction]);

        // Compute 1-degree neighbors of latestNode
        const getOneDegreeNodes = () => {
          if (!latestNode || !data) return new Set();
          const neighbors = new Set();
          neighbors.add(latestNode);
          data.links.forEach(link => {
            if (link.source === latestNode) neighbors.add(link.target);
            if (link.target === latestNode) neighbors.add(link.source);
          });
          return neighbors;
        };
        const oneDegreeNodes = getOneDegreeNodes();

        // Compute N-degree neighbors of latestNode
        const visibleDegree = 1; // Change this value to adjust visible degree
        const getNDegreeNodes = (startNode, degree) => {
          if (!startNode || !data) return new Set();
          const visited = new Set();
          let currentLevel = new Set([startNode]);
          for (let d = 0; d < degree; d++) {
            const nextLevel = new Set();
            data.links.forEach(link => {
              // Normalize source/target to node names if they are objects
              const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
              const targetName = typeof link.target === 'object' ? link.target.name : link.target;
              currentLevel.forEach(n => {
                if (n === sourceName && !visited.has(targetName)) {
                  nextLevel.add(targetName);
                }
                if (n === targetName && !visited.has(sourceName)) {
                  nextLevel.add(sourceName);
                }
              });
            });
            nextLevel.forEach(n => visited.add(n));
            currentLevel.forEach(n => visited.add(n));
            currentLevel = nextLevel;
          }
          visited.add(startNode);
          return visited;
        };
        // For visibility: use hover (focusNode) if available, otherwise clicked node, otherwise latestNode
        const visibilityFocus = focusNode || clickedNode || latestNode;
        // For zoom: use the most recent action
        const zoomFocus = lastAction === 'search' ? 'search' : 
                         lastAction === 'click' ? clickedNode : 
                         lastAction === 'latestNode' ? latestNode :
                         lastAction === 'mutation' ? mutatedNodes[0] : null;
        const visibilityNodes = getNDegreeNodes(visibilityFocus, visibleDegree);
        
        // Always include search results in visibility if there's a search term
        if (inputValue && inputValue.trim()) {
          const searchMatches = data.nodes.filter(node => 
            node.name.toLowerCase().includes(inputValue.toLowerCase()) ||
            (node.location && node.location.toLowerCase().includes(inputValue.toLowerCase())) ||
            (node.role && node.role.toLowerCase().includes(inputValue.toLowerCase())) ||
            (node.website && node.website.toLowerCase().includes(inputValue.toLowerCase()))
          );
          searchMatches.forEach(match => {
            const matchNeighbors = getNDegreeNodes(match.name, visibleDegree);
            matchNeighbors.forEach(neighbor => visibilityNodes.add(neighbor));
          });
        }
        
        // Always include mutated nodes in visibility if there was a mutation
        if (lastAction === 'mutation' && mutatedNodes.length > 0) {
          mutatedNodes.forEach(nodeName => {
            const nodeNeighbors = getNDegreeNodes(nodeName, 0); // Always use 0 degree for mutations
            nodeNeighbors.forEach(neighbor => visibilityNodes.add(neighbor));
          });
        }
        
        const zoomNodes = lastAction === 'search' ? 
                         (() => {
                           const searchMatches = data.nodes.filter(node => 
                             node.name.toLowerCase().includes(inputValue.toLowerCase()) ||
                             (node.location && node.location.toLowerCase().includes(inputValue.toLowerCase())) ||
                             (node.role && node.role.toLowerCase().includes(inputValue.toLowerCase())) ||
                             (node.website && node.website.toLowerCase().includes(inputValue.toLowerCase()))
                           );
                           const searchNodes = new Set();
                           searchMatches.forEach(match => {
                             const matchNeighbors = getNDegreeNodes(match.name, visibleDegree);
                             matchNeighbors.forEach(neighbor => searchNodes.add(neighbor));
                           });
                           return searchNodes;
                         })() : 
                         lastAction === 'mutation' ?
                         (() => {
                           const mutationNodes = new Set();
                           mutatedNodes.forEach(nodeName => {
                             const nodeNeighbors = getNDegreeNodes(nodeName, 1); // Always use 1 degree for mutations
                             nodeNeighbors.forEach(neighbor => mutationNodes.add(neighbor));
                           });
                           return mutationNodes;
                         })() :
                         getNDegreeNodes(zoomFocus, visibleDegree);
        
        // Auto-zoom to visible nodes
        useEffect(() => {
          // Only auto-zoom if there's a search term or if a node was clicked (not just hovered)
          // Don't auto-zoom for latestNode unless there's no other focus
          if (fgRef.current && zoomNodes.size > 0) {
            // Zoom based on last action
            if (lastAction === 'click' && clickedNode) {
              const visibleNodes = data.nodes.filter(node => zoomNodes.has(node.name));
              if (visibleNodes.length > 0) {
                // Calculate bounding box of visible nodes
                const xs = visibleNodes.map(n => n.x);
                const ys = visibleNodes.map(n => n.y);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);
                
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;
                const width = maxX - minX;
                const height = maxY - minY;
                
                // Add some padding
                const padding = 100;
                const scale = Math.min(
                  (window.innerWidth - padding) / width,
                  (window.innerHeight - padding) / height,
                  2 // Max zoom level
                );
                
                fgRef.current.centerAt(centerX, centerY, 1000);
                fgRef.current.zoom(scale, 1000);
              }
            }
            // For search results (only if no node is clicked)
            else if (lastAction === 'search' && inputValue) {
              const visibleNodes = data.nodes.filter(node => zoomNodes.has(node.name));
              if (visibleNodes.length > 0) {
                // Calculate bounding box of visible nodes
                const xs = visibleNodes.map(n => n.x);
                const ys = visibleNodes.map(n => n.y);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);
                
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;
                const width = maxX - minX;
                const height = maxY - minY;
                
                // Add some padding
                const padding = 100;
                const scale = Math.min(
                  (window.innerWidth - padding) / width,
                  (window.innerHeight - padding) / height,
                  2 // Max zoom level
                );
                
                fgRef.current.centerAt(centerX, centerY, 1000);
                fgRef.current.zoom(scale, 1000);
              }
            }
            // For latestNode, delay the zoom to allow graph to stabilize
            else if (lastAction === 'latestNode' && latestNode) {
              setTimeout(() => {
                const visibleNodes = data.nodes.filter(node => zoomNodes.has(node.name));
                if (visibleNodes.length > 0 && fgRef.current) {
                  // Calculate bounding box of visible nodes
                  const xs = visibleNodes.map(n => n.x);
                  const ys = visibleNodes.map(n => n.y);
                  const minX = Math.min(...xs);
                  const maxX = Math.max(...xs);
                  const minY = Math.min(...ys);
                  const maxY = Math.max(...ys);
                  
                  const centerX = (minX + maxX) / 2;
                  const centerY = (minY + maxY) / 2;
                  const width = maxX - minX;
                  const height = maxY - minY;
                  
                  // Add some padding
                  const padding = 100;
                  const scale = Math.min(
                    (window.innerWidth - padding) / width,
                    (window.innerHeight - padding) / height,
                    2 // Max zoom level
                  );
                  
                  fgRef.current.centerAt(centerX, centerY, 1000);
                  fgRef.current.zoom(scale, 1000);
                }
              }, 1000); // 1 second delay for latestNode
            }
            // For mutation queries, zoom to the mutated nodes
            else if (lastAction === 'mutation' && mutatedNodes.length > 0) {
              setTimeout(() => {
                const visibleNodes = data.nodes.filter(node => zoomNodes.has(node.name));
                if (visibleNodes.length > 0 && fgRef.current) {
                  // Calculate bounding box of visible nodes
                  const xs = visibleNodes.map(n => n.x);
                  const ys = visibleNodes.map(n => n.y);
                  const minX = Math.min(...xs);
                  const maxX = Math.max(...xs);
                  const minY = Math.min(...ys);
                  const maxY = Math.max(...ys);
                  
                  const centerX = (minX + maxX) / 2;
                  const centerY = (minY + maxY) / 2;
                  const width = maxX - minX;
                  const height = maxY - minY;
                  
                  // Add some padding
                  const padding = 100;
                  const scale = Math.min(
                    (window.innerWidth - padding) / width,
                    (window.innerHeight - padding) / height,
                    2 // Max zoom level
                  );
                  
                  fgRef.current.centerAt(centerX, centerY, 1000);
                  fgRef.current.zoom(scale, 1000);
                }
              }, 1000); // 1 second delay for mutation
            }
          }
        }, [zoomNodes, data.nodes, fgRef, lastAction, clickedNode, latestNode, inputValue, mutatedNodes]);

        const handleInputChange = (event) => {
          const input = event.target.value;
          setInputValue(input);
          handleChange(event); // updates CypherViz state.query too
          
          // Update user activity when typing
          updateUserActivity();
          
          // Clear other actions when searching
          if (input.trim()) {
            setClickedNode(null);
            setLastAction('search');
          }
        };

        const handleSubmit = async (e) => {
          e.preventDefault();

          try {
            const response = await fetch("https://flowise-hako.onrender.com/api/v1/prediction/29e305b3-c569-4676-a454-1c4fdc380c69", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question: inputValue })
            });

            const data = await response.json();
            const generatedQuery = data.text || data.query || "";

            // More specific detection for true analytical questions vs visualization requests
            const isTrueAnalyticalQuestion = (() => {
              const question = inputValue.toLowerCase();
              const analyticalKeywords = ['how many', 'how much', 'what is', 'what are', 'when', 'where', 'why', 'who', 'which', 'how', 'what'];
              
              // True analytical questions that ask for specific data points
              const analyticalPatterns = [
                /how many/i,
                /how much/i,
                /what is the (count|number|total)/i,
                /what are the (count|numbers|totals)/i,
                /count of/i,
                /total number of/i,
                /how many (artists|users|people|connections|relationships)/i,
                /what (roles|locations|websites) (exist|are there)/i,
                /which (roles|locations|websites)/i,
                /what is the most common/i,
                /what is the average/i,
                /how many people are (in|from)/i
              ];
              
              // Visualization requests that should NOT be treated as analytical
              const visualizationPatterns = [
                /show me/i,
                /display/i,
                /visualize/i,
                /find/i,
                /search for/i,
                /look for/i,
                /get/i,
                /bring up/i,
                /open/i
              ];
              
              // If it matches visualization patterns, it's NOT analytical
              if (visualizationPatterns.some(pattern => pattern.test(question))) {
                return false;
              }
              
              // If it matches analytical patterns, it IS analytical
              if (analyticalPatterns.some(pattern => pattern.test(question))) {
                return true;
              }
              
              // Default: if it contains analytical keywords but doesn't match visualization patterns
              return analyticalKeywords.some(keyword => question.includes(keyword));
            })();

            if (isTrueAnalyticalQuestion) {
              // For analytical questions, execute the query and provide a text answer
              try {
                const session = driver.session({ database: "neo4j" });
                const result = await session.run(generatedQuery);
                await session.close();

                // Generate a human-readable answer based on the query results
                const answer = generateAnalyticalAnswer(inputValue, result, generatedQuery);
                
                // Display the answer in a modal or notification
                displayAnalyticalAnswer(answer, inputValue);
                
                // Clear the input after showing the answer
                setTimeout(() => {
                  setInputValue("");
                }, 5000); // Keep answer visible longer for analytical questions
                
              } catch (queryError) {
                console.error("Error executing analytical query:", queryError);
                displayAnalyticalAnswer("Sorry, I couldn't analyze that question. Please try rephrasing it.", inputValue);
              }
            } else {
              // For regular queries, proceed with the existing logic
              setInputValue(generatedQuery);
              handleChange({ target: { value: generatedQuery } });

              await loadData(null, generatedQuery);

              // Check if the generated query is a mutation query (updates the graph)
              const isMutationQuery = /(CREATE|MERGE|SET|DELETE|REMOVE|DETACH DELETE)/i.test(generatedQuery.trim());
              
              // If it's a mutation query, immediately return to default state
              if (isMutationQuery) {
                
                // Extract node names from the mutation query to track what was created/modified
                let extractedNodes = [];
                
                // Handle different mutation query patterns
                if (generatedQuery.includes('DELETE')) {
                  // For DELETE queries, extract from patterns like DELETE (u:User {name: "John"}) or MATCH (u:User {name: "John"}) DELETE u
                  const deleteMatches = generatedQuery.match(/\{name:\s*['"]([^'"]+)['"]\}/g);
                  if (deleteMatches) {
                    extractedNodes = deleteMatches.map(match => {
                      const nameMatch = match.match(/name:\s*['"]([^'"]+)['"]/);
                      return nameMatch ? nameMatch[1] : null;
                    }).filter(Boolean);
                  }
                } else if (generatedQuery.includes('SET')) {
                  // For SET queries, extract from MATCH clause like MATCH (u:User {name: "John"}) SET u.role = 'admin'
                  const matchClause = generatedQuery.match(/MATCH\s*\([^)]*\{name:\s*['"]([^'"]+)['"][^}]*\}\)/i);
                  if (matchClause) {
                    extractedNodes = [matchClause[1]];
                  }
                } else {
                  // For CREATE/MERGE queries, extract from {name: "nodeName"} patterns
                  const nodeMatches = generatedQuery.match(/\{([^}]+)\}/g);
                  extractedNodes = nodeMatches ? 
                    nodeMatches.map(match => {
                      const nameMatch = match.match(/name:\s*['"]([^'"]+)['"]/);
                      return nameMatch ? nameMatch[1] : null;
                    }).filter(Boolean) : [];
                }
                
                setMutatedNodes(extractedNodes);
                setLastAction('mutation');
                
                // Immediately return to default query without any delay
                const defaultQuery = `
                  MATCH (u:User)-[r:CONNECTED_TO]->(v:User)
                  RETURN u.name AS source, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite, 
                         v.name AS target, v.role AS targetRole, v.location AS targetLocation, v.website AS targetWebsite
                `;
                await loadData(null, defaultQuery);
              }
              
              // Clear the input after 3 seconds
              setTimeout(() => {
                setInputValue("");
              }, 3000);
            }
            
            } catch (error) {
              console.error("Flowise call failed:", error);
            }
        };

        const handleNodeClick = (node) => {
          if (!node) return;
          setSelectedNode(node);
          setEditedNode({ ...node });
          setFocusNode(node.name);
          setClickedNode(node.name);
          setLastAction('click');
          
          // Update user activity when clicking nodes
          updateUserActivity();
          
          // Clear search when clicking a node to avoid zoom conflicts
          setInputValue("");
        };

        const handleNodeHover = (node) => {
          if (node) {
            setFocusNode(node.name);
          } else {
            setFocusNode(null);
          }
        };

        const handleEditChange = (event) => {
          const { name, value } = event.target;
          setEditedNode((prev) => ({
            ...prev,
            [name]: value,
          }));
        };

        const saveNodeChanges = async () => {
          if (!editedNode || !selectedNode) return;

          // Helper function to capitalize first letter of each word
          const capitalizeWords = (str) => {
            if (!str) return str;
            return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
          };

          const session = driver.session();
          try {
            await session.run(
              `MATCH (u:User {name: $oldName}) 
              SET u.name = $newName`,
              {
                oldName: selectedNode.name,
                newName: capitalizeWords(editedNode.name),
              }
            );
            await loadData(editedNode.name); // Keep the edited node as latestNode
            setSelectedNode(null); // Close the panel
          } catch (error) {
            console.error("Error updating node:", error);
          } finally {
            session.close();
          }
        };

        // Helper function to generate human-readable answers from query results
        const generateAnalyticalAnswer = (question, result, query) => {
          const questionLower = question.toLowerCase();
          const records = result.records;
          
          // Debug logging to see what's happening
          console.log("Analytical question:", question);
          console.log("Generated query:", query);
          console.log("Query result:", result);
          console.log("Records:", records);
          
          if (records.length === 0) {
            return "I couldn't find any data matching your question.";
          }

          // Handle count queries
          if (questionLower.includes('how many') || questionLower.includes('count')) {
            const count = records[0].get(0);
            
            // Debug: Log the actual query and result for count queries
            console.log("Count query result:", count);
            console.log("Question was:", question);
            
            if (questionLower.includes('artist')) {
              return `There are ${count} artists.`;
            } else if (questionLower.includes('user')) {
              return `There are ${count} users.`;
            } else if (questionLower.includes('connection') || questionLower.includes('relationship')) {
              return `There are ${count} connections.`;
            } else if (questionLower.includes('craftsman')) {
              return `There are ${count} craftsmen.`;
            } else if (questionLower.includes('entrepreneur')) {
              return `There are ${count} entrepreneurs.`;
            } else if (questionLower.includes('educational institution') || questionLower.includes('institution')) {
              return `There are ${count} educational institutions.`;
            } else if (questionLower.includes('holder')) {
              return `There are ${count} holder.`;
            } else if (questionLower.includes('affiliate')) {
              return `There are ${count} affiliates.`;
            } else {
              return `The count is ${count}.`;
            }
          }

          // Handle location-based queries
          if (questionLower.includes('where') || questionLower.includes('location')) {
            let locations = [];
            
            // Try different case variations for location field
            if (records[0].keys && records[0].keys.includes('location')) {
              locations = records.map(record => record.get('location')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('Location')) {
              locations = records.map(record => record.get('Location')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_location')) {
              locations = records.map(record => record.get('u_location')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_Location')) {
              locations = records.map(record => record.get('u_Location')).filter(Boolean);
            } else {
              locations = records.map(record => record.get(0)).filter(Boolean);
            }
            
            const uniqueLocations = [...new Set(locations)];
            if (uniqueLocations.length === 1) {
              return `The location is ${uniqueLocations[0]}.`;
            } else {
              return `The locations found are: ${uniqueLocations.join(', ')}.`;
            }
          }

          // Handle role-based queries
          if (questionLower.includes('role') || questionLower.includes('what do')) {
            let roles = [];
            
            // Try different case variations for role field
            if (records[0].keys && records[0].keys.includes('role')) {
              roles = records.map(record => record.get('role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('Role')) {
              roles = records.map(record => record.get('Role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_role')) {
              roles = records.map(record => record.get('u_role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_Role')) {
              roles = records.map(record => record.get('u_Role')).filter(Boolean);
            } else {
              roles = records.map(record => record.get(0)).filter(Boolean);
            }
            
            const uniqueRoles = [...new Set(roles)];
            if (uniqueRoles.length === 1) {
              return `The role is ${uniqueRoles[0]}.`;
            } else {
              return `The roles found are: ${uniqueRoles.join(', ')}.`;
            }
          }

          // Handle name-based queries
          if (questionLower.includes('who') || questionLower.includes('name')) {
            let names = [];
            
            // Try different case variations for name field
            if (records[0].keys && records[0].keys.includes('name')) {
              names = records.map(record => record.get('name')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('Name')) {
              names = records.map(record => record.get('Name')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_name')) {
              names = records.map(record => record.get('u_name')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_Name')) {
              names = records.map(record => record.get('u_Name')).filter(Boolean);
            } else {
              names = records.map(record => record.get(0)).filter(Boolean);
            }
            
            if (names.length === 1) {
              return `The person is ${names[0]}.`;
            } else if (names.length <= 5) {
              return `The people are: ${names.join(', ')}.`;
            } else {
              return `Found ${names.length} people: ${names.slice(0, 3).join(', ')} and ${names.length - 3} more.`;
            }
          }

          // Handle "what roles exist" specifically
          if (questionLower.includes('what roles exist') || questionLower.includes('what roles are there')) {
            // Try to extract roles from different possible result formats
            let roles = [];
            
            // Check if the query returned role data - try different case variations
            if (records[0].keys && records[0].keys.includes('role')) {
              roles = records.map(record => record.get('role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('Role')) {
              roles = records.map(record => record.get('Role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_role')) {
              roles = records.map(record => record.get('u_role')).filter(Boolean);
            } else if (records[0].keys && records[0].keys.includes('u_Role')) {
              roles = records.map(record => record.get('u_Role')).filter(Boolean);
            } else {
              // Try to get the first column as roles
              roles = records.map(record => record.get(0)).filter(Boolean);
            }
            
            const uniqueRoles = [...new Set(roles)];
            if (uniqueRoles.length > 0) {
              return `The roles found in the network are: ${uniqueRoles.join(', ')}.`;
            } else {
              return "I couldn't find any role information in the network.";
            }
          }

          // Default response for other queries
          const resultCount = records.length;
          if (resultCount === 1) {
            return "I found 1 result matching your question.";
          } else {
            return `I found ${resultCount} results matching your question.`;
          }
        };

        // Helper function to display analytical answers
        const displayAnalyticalAnswer = (answer, question) => {
          setAnalyticalAnswer({ answer, question });
          setShowAnalyticalModal(true);
          
          // Auto-hide after 8 seconds
          setTimeout(() => {
            setShowAnalyticalModal(false);
            setAnalyticalAnswer(null);
          }, 8000);
        };


return (
    <div width="95%">
      <input
        type="text"
        placeholder="Show me all the entrepreneurs connected to USC... or search by email..."
        style={{ display: "block", width: "95%", height: "40px", margin: "0 auto", textAlign: "center", padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }}
        value={inputValue}
        onChange={handleInputChange}
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
      />
      <button id="visualize" onClick={() => window.open("https://awuchen.github.io/GreifNet/", "_blank")}>Visualize3D</button>
      <button id="info" onClick={() => window.open("https://www.hako.soooul.xyz/drafts/washi", "_blank")}>Info</button>
      

      
      {/* Mutation processing indicator */}
      {processingMutation && (
        <div style={{
          position: "fixed",
          top: "60px",
          right: "10px",
          padding: "8px 12px",
          backgroundColor: "#9C27B0",
          color: "white",
          borderRadius: "4px",
          fontSize: "12px",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          gap: "8px"
        }}>
          <div style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: "#fff",
            animation: "pulse 0.5s infinite"
          }}></div>
          Processing Mutation...
        </div>
      )}

      {/* Analytical Answer Modal */}
      {showAnalyticalModal && analyticalAnswer && (
        <div 
          style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3>Network Analysis</h3>
          <p><strong>Question:</strong> "{analyticalAnswer.question}"</p>
          <p><strong>Answer:</strong> {analyticalAnswer.answer}</p>
        </div>
      )}
      

      
      <style>{`
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }
        
        @keyframes breathe {
          0%, 100% { 
            transform: scale(1);
            opacity: 1;
          }
          50% { 
            transform: scale(1.5);
            opacity: 0.7;
          }
        }
      `}</style>

  <ForceGraph2D
  ref={fgRef}
  graphData={data}
  nodeId="name"
  nodeLabel={(node) => node.location || "No Location"}
  onNodeClick={handleNodeClick}
  onNodeHover={handleNodeHover}
  onBackgroundClick={() => {
    setFocusNode(null);
    setClickedNode(null);
    setLastAction(null);
    setMutatedNodes([]);
    setSelectedNode(null);
    setShowAnalyticalModal(false);
    setAnalyticalAnswer(null);
  }}
  nodeCanvasObject={(node, ctx) => {
    const isHighlighted =
      inputValue &&
      (node.name.toLowerCase().includes(inputValue.toLowerCase()) ||
        (node.location && node.location.toLowerCase().includes(inputValue.toLowerCase())) ||
        (node.role && node.role.toLowerCase().includes(inputValue.toLowerCase())) ||
        (node.website && node.website.toLowerCase().includes(inputValue.toLowerCase())));
    const isNDegree = visibilityNodes.has(node.name);

    ctx.globalAlpha = isNDegree ? 1.0 : 0.2;
    
    // Add breathing effect when user is idle or transitioning
    let nodeRadius = 6;
    const now = Date.now();
    
    // Frame rate optimization: only update every 60ms (16fps) for better performance
    const frameRate = 60;
    const time = Math.floor(now / frameRate) * frameRate * 0.001;
    
    if (!isUserActive) {
      // Optimized breathing effect with cached calculations
      // Use a simpler sine wave with reduced frequency for better performance
      const breathingScale = 1 + 0.1 * Math.sin(time * 0.8); // Reduced frequency from 1.5 to 0.8
      nodeRadius = 6 * breathingScale;
    } else if (scaleTransitionStart && (now - scaleTransitionStart) < scaleTransitionDuration) {
      // Optimized transition with cached calculations
      const transitionProgress = Math.min((now - scaleTransitionStart) / scaleTransitionDuration, 1);
      // Cache the breathing scale calculation
      const breathingScale = 1 + 0.1 * Math.sin((scaleTransitionStart * 0.001) * 0.8);
      const targetScale = 1;
      const currentScale = breathingScale + (targetScale - breathingScale) * transitionProgress;
      nodeRadius = 6 * currentScale;
    }
    
    // Use latestNode for editing (black), pollingFocusNode for viewing (blue), or white for normal
    let fillColor = "white";
    if (node.name === latestNode) {
      fillColor = "black"; // Editable node
    } else if (node.name === pollingFocusNode) {
      fillColor = "green"; // Non-editable polling focus
    }
    
    // Add subtle color shift during breathing animation
    if (!isUserActive && fillColor === "white") {
      // Optimized color shift with reduced frequency and frame rate optimization
      const colorShift = Math.sin(time * 0.8) * 0.1;
      // Shift towards a very light blue during breathing
      fillColor = `rgb(${255 + colorShift * 50}, ${255 + colorShift * 30}, ${255 + colorShift * 100})`;
    } else if (scaleTransitionStart && (now - scaleTransitionStart) < scaleTransitionDuration && fillColor === "white") {
      // Optimized color transition with cached calculations
      const transitionProgress = (now - scaleTransitionStart) / scaleTransitionDuration;
      // Cache the color shift calculation
      const lastColorShift = Math.sin((scaleTransitionStart * 0.001) * 0.8) * 0.1;
      const currentColorShift = lastColorShift * (1 - transitionProgress);
      fillColor = `rgb(${255 + currentColorShift * 50}, ${255 + currentColorShift * 30}, ${255 + currentColorShift * 100})`;
    }
    
    // Add subtle glow effect during breathing animation
    // Removed shadow and alpha effects for performance
    
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = isHighlighted ? "red" : "black";
    ctx.lineWidth = isHighlighted ? 3 : 2;

    ctx.beginPath();
    ctx.arc(node.x || Math.random() * 500, node.y || Math.random() * 500, nodeRadius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    // Reset shadow for text
    ctx.shadowBlur = 0;
    ctx.fillStyle = "gray";
    ctx.fillText(node.role, node.x + 10, node.y);

    ctx.globalAlpha = 1.0; // Reset alpha for next node
  }}
  linkColor={(link) => {
    const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
    const targetName = typeof link.target === 'object' ? link.target.name : link.target;
    const isConnected = visibilityNodes.has(sourceName) && visibilityNodes.has(targetName);
    return isConnected ? '#999' : '#ccc';
  }}
  linkOpacity={(link) => {
    const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
    const targetName = typeof link.target === 'object' ? link.target.name : link.target;
    const isConnected = visibilityNodes.has(sourceName) && visibilityNodes.has(targetName);
    return isConnected ? 1.0 : 0.15;
  }}
  linkCurvature={0.2}
  linkDirectionalArrowRelPos={1}
  linkDirectionalArrowLength={5}
  />

  {selectedNode && editedNode && (
    <div 
      style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000 }}
      onClick={(e) => e.stopPropagation()}
    >
    {selectedNode.name === latestNode ? (
      <>
      <h3>Network Info</h3>
      <p><strong>Name:</strong>
      <input 
      name="name" 
      value={editedNode.name} 
      placeholder="Enter name" 
      onChange={handleEditChange}
      onFocus={(e) => e.target.placeholder = ""}
      onBlur={(e) => e.target.placeholder = "Enter name"} 
      /></p>

      <p><button onClick={saveNodeChanges}>Save</button></p>
      </>
      ) : (
      <>
      <h3>Network Info</h3>
      <p><strong>Name:</strong> {selectedNode?.name}</p>
      <p><strong>Role:</strong> {selectedNode?.role}</p>
      <p><strong>Location:</strong> {selectedNode?.location}</p>
      <p><strong>Email:</strong>{" "}
      {selectedNode.website && selectedNode.website !== "" ? (
        <a href={`mailto:${selectedNode.website}`}>
        {selectedNode.website.length > 30 
          ? `${selectedNode.website.substring(0, 30)}...`
        : selectedNode.website}
        </a>
        ) : (
        ""
      )}</p>
      </>
    )}
    </div>
  )}
  </div>
  );
    };





    export default CypherViz;

