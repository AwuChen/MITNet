import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './App.css';
import ForceGraph2D from 'react-force-graph-2d';
import * as d3 from 'd3';
import migrateTimestamps from './migrateTimestamps';

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
      timelineMode: false, // Timeline mode toggle
      timelineDate: null, // Current timeline date
      timelineData: null, // Timeline-specific data
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
      if (!this.state.isUserActive && this.fgRef.current && !this.state.timelineMode) {
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

  // Add timestamps to mutation queries automatically
  addTimestampsToMutationQuery = (query) => {
    if (!query || typeof query !== 'string') return query;
    
    const trimmedQuery = query.trim();
    const timestamp = Date.now();
    
    // Check if this is a mutation query
    const isMutationQuery = /(CREATE|MERGE|SET|DELETE|REMOVE|DETACH DELETE)/i.test(trimmedQuery);
    if (!isMutationQuery) return query;
    
    // Skip processing if this is an NFC operation to prevent duplicate timestamps
    if (this.isNFCOperation) {
      console.log('Skipping timestamp processing for NFC operation');
      return query;
    }
    
    console.log(`Processing mutation query with timestamps: ${query}`);
    
    let processedQuery = query;
    
    // Add timestamps to CREATE User operations
    processedQuery = processedQuery.replace(
      /CREATE\s*\(([^:]+):User\s*\{([^}]*)\}\)/gi,
      (match, alias, properties) => {
        // Remove existing createdAt if present
        const cleanProperties = properties.replace(/createdAt\s*:\s*[^,}]+/g, '');
        // Add timestamp - handle trailing comma and closing brace properly
        let newProperties = cleanProperties.trim();
        if (newProperties.endsWith(',')) {
          newProperties = newProperties.slice(0, -1); // Remove trailing comma
        }
        newProperties = `${newProperties}, createdAt: ${timestamp}`;
        
        // Extract name property for MERGE matching
        const nameMatch = properties.match(/name\s*:\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
          const name = nameMatch[1];
          // Use MERGE with name only, then set other properties on CREATE
          return `MERGE (${alias}:User {name: '${name}'}) ON CREATE SET ${alias}.createdAt = ${timestamp}`;
        }
        
        return `CREATE (${alias}:User {${newProperties}})`;
      }
    );
    
    // Add timestamps to MERGE User operations with ON CREATE
    processedQuery = processedQuery.replace(
      /MERGE\s*\(([^:]+):User\s*\{([^}]*)\}\)\s*ON CREATE SET\s*([^}]*)/gi,
      (match, alias, properties, setClause) => {
        // Add createdAt to ON CREATE SET if not present
        if (!setClause.includes('createdAt')) {
          let newSetClause = setClause.trim();
          if (newSetClause.endsWith(',')) {
            newSetClause = newSetClause.slice(0, -1); // Remove trailing comma
          }
          newSetClause = `${newSetClause}, ${alias}.createdAt = ${timestamp}`;
          return `MERGE (${alias}:User {${properties}}) ON CREATE SET ${newSetClause}`;
        }
        return match;
      }
    );
    
    // Add timestamps to relationship creation (various patterns)
    // Pattern 1: CREATE (a)-[:CONNECTED_TO]->(b)
    processedQuery = processedQuery.replace(
      /CREATE\s*\(([^)]+)\)-\[:CONNECTED_TO\]->\(([^)]+)\)/gi,
      (match, source, target) => {
        return `CREATE (${source})-[r:CONNECTED_TO]->(${target}) SET r.createdAt = ${timestamp}`;
      }
    );
    
    // Pattern 2: CREATE (a)-[r:CONNECTED_TO]->(b)
    processedQuery = processedQuery.replace(
      /CREATE\s*\(([^)]+)\)-\[([^:]+):CONNECTED_TO\]->\(([^)]+)\)/gi,
      (match, source, alias, target) => {
        return `CREATE (${source})-[${alias}:CONNECTED_TO]->(${target}) SET ${alias}.createdAt = ${timestamp}`;
      }
    );
    
    // Pattern 3: MERGE (a)-[:CONNECTED_TO]->(b) ON CREATE SET
    processedQuery = processedQuery.replace(
      /MERGE\s*\(([^)]+)\)-\[:CONNECTED_TO\]->\(([^)]+)\)\s*ON CREATE SET\s*([^}]*)/gi,
      (match, source, target, setClause) => {
        if (!setClause.includes('createdAt')) {
          let newSetClause = setClause.trim();
          if (newSetClause.endsWith(',')) {
            newSetClause = newSetClause.slice(0, -1); // Remove trailing comma
          }
          newSetClause = `${newSetClause}, r.createdAt = ${timestamp}`;
          return `MERGE (${source})-[r:CONNECTED_TO]->(${target}) ON CREATE SET ${newSetClause}`;
        }
        return match;
      }
    );
    
    // Pattern 4: MERGE (a)-[r:CONNECTED_TO]->(b) ON CREATE SET
    processedQuery = processedQuery.replace(
      /MERGE\s*\(([^)]+)\)-\[([^:]+):CONNECTED_TO\]->\(([^)]+)\)\s*ON CREATE SET\s*([^}]*)/gi,
      (match, source, alias, target, setClause) => {
        if (!setClause.includes('createdAt')) {
          let newSetClause = setClause.trim();
          if (newSetClause.endsWith(',')) {
            newSetClause = newSetClause.slice(0, -1); // Remove trailing comma
          }
          newSetClause = `${newSetClause}, ${alias}.createdAt = ${timestamp}`;
          return `MERGE (${source})-[${alias}:CONNECTED_TO]->(${target}) ON CREATE SET ${newSetClause}`;
        }
        return match;
      }
    );
    
    // Pattern 5: MERGE (a)-[:CONNECTED_TO]->(b) (without ON CREATE)
    processedQuery = processedQuery.replace(
      /MERGE\s*\(([^)]+)\)-\[:CONNECTED_TO\]->\(([^)]+)\)/gi,
      (match, source, target) => {
        return `MERGE (${source})-[r:CONNECTED_TO]->(${target}) ON CREATE SET r.createdAt = ${timestamp}`;
      }
    );
    
    // Pattern 6: MERGE (a)-[r:CONNECTED_TO]->(b) (without ON CREATE)
    processedQuery = processedQuery.replace(
      /MERGE\s*\(([^)]+)\)-\[([^:]+):CONNECTED_TO\]->\(([^)]+)\)(?!\s*ON CREATE)/gi,
      (match, source, alias, target) => {
        return `MERGE (${source})-[${alias}:CONNECTED_TO]->(${target}) ON CREATE SET ${alias}.createdAt = ${timestamp}`;
      }
    );
    
    console.log(`Processed mutation query with timestamps: ${processedQuery}`);
    return processedQuery;
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
    
    // Block DELETE operations for user safety
    const isDeleteQuery = /(DELETE|DETACH DELETE|REMOVE)/i.test(queryToExecute.trim());
    if (isDeleteQuery) {
      alert('DELETE operations are not allowed for safety reasons. Please use other operations like CREATE, MERGE, or SET.');
      return;
    }
    
    try {
      // Preprocess mutation queries to add timestamps
      let processedQuery = queryToExecute;
      if (isMutationQuery && !this.isNFCOperation) {
        processedQuery = this.addTimestampsToMutationQuery(queryToExecute);
      }
  
      res = await session.run(processedQuery);
      
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
      
      // Note: Focus timeout is now managed in GraphView component
      
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

    // Focus on a newly added node with temporary focus (1 second) then return to user control
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
        // Focus on the node
        this.fgRef.current.centerAt(newNode.x, newNode.y, 1500);
        this.fgRef.current.zoom(1.25);
        
        // Set the latestNode state for visual highlighting
        this.setState({ latestNode: nodeName });
        
        // Note: Focus timeout is now managed in GraphView component
        // The auto-zoom will handle the temporary focus behavior
        
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
    
    // Run timestamp migration for existing data
    migrateTimestamps(this.driver);
    
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
    
    // Note: Focus timeout is now managed in GraphView component
    
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
    const capitalizedNfcUser = capitalizeWords(nfcUserName);

    // Set NFC operation flag to prevent double reload
    this.isNFCOperation = true;

    // Clear any existing pending NFC node to prevent conflicts
    if (this.pendingNFCNode) {
      this.pendingNFCNode = null;
    }

    let session = this.driver.session({ database: "neo4j" });
    try {
      // Create a single timestamp for the entire operation
      const timestamp = Date.now();
      
      // First, check if a node with the same name as the new user already exists
      const checkExistingUser = await session.run(
        `MATCH (u:User {name: $user}) RETURN u.name as name`,
        { user: capitalizedNewUser }
      );

      let nodeToFocus = capitalizedNewUser;
      let isExistingNode = false;

      if (checkExistingUser.records.length > 0) {
        // Node with this name already exists, use the existing node
        console.log(`Node with name "${capitalizedNewUser}" already exists, using existing node`);
        isExistingNode = true;
        nodeToFocus = capitalizedNewUser;
      } else {
        // Node doesn't exist, create a new one
        console.log(`Creating new node with name "${capitalizedNewUser}"`);
      }

      // Only run duplicate cleanup for new nodes, not for existing nodes being merged
      if (!this.isNFCOperation || !this.pendingNFCNode) {
        // First, check if there are multiple nodes with the same name and merge them
        const duplicateCheck = await session.run(
          `MATCH (u:User {name: $user})
           RETURN count(u) as count`,
          { user: capitalizedNewUser }
        );
        
        const duplicateCount = duplicateCheck.records[0].get('count').toNumber();
        
        if (duplicateCount > 1) {
          console.log(`Found ${duplicateCount} duplicate nodes for "${capitalizedNewUser}", merging them...`);
          
          // Get all nodes with this name and their properties
          const allNodes = await session.run(
            `MATCH (u:User {name: $user})
             RETURN u.role as role, u.location as location, u.website as website
             ORDER BY u.role DESC, u.location DESC, u.website DESC`,
            { user: capitalizedNewUser }
          );
          
          // Find the best properties (non-empty values)
          let bestRole = '';
          let bestLocation = '';
          let bestWebsite = '';
          
          allNodes.records.forEach(record => {
            const role = record.get('role');
            const location = record.get('location');
            const website = record.get('website');
            
            if (role && role !== '') bestRole = role;
            if (location && location !== '') bestLocation = location;
            if (website && website !== '') bestWebsite = website;
          });
          
          // Delete all nodes with this name and recreate with best properties
          await session.run(
            `MATCH (u:User {name: $user})
             DETACH DELETE u`,
            { user: capitalizedNewUser }
          );
          
          // Create a single node with the best properties
          await session.run(
            `CREATE (u:User {name: $user, role: $role, location: $location, website: $website, createdAt: $createdAt})`,
            { 
              user: capitalizedNewUser,
              role: bestRole,
              location: bestLocation,
              website: bestWebsite,
              createdAt: timestamp
            }
          );
          
          console.log(`Merged duplicate nodes for "${capitalizedNewUser}" with properties:`, { bestRole, bestLocation, bestWebsite, timestamp });
        }
      }

      // Create or connect the nodes
      // Use the same timestamp for consistency across all operations
      await session.run(
        `MERGE (u:User {name: $user}) 
         ON CREATE SET u.role = '', 
                       u.location = '', 
                       u.website = '',
                       u.createdAt = $timestamp

         MERGE (nfc:User {name: $nfcUser}) 
         ON CREATE SET nfc.role = '', 
                       nfc.location = '', 
                       nfc.website = '',
                       nfc.createdAt = $timestamp

         MERGE (u)-[r:CONNECTED_TO]->(nfc) 
         ON CREATE SET r.createdAt = $timestamp
        `,
        { 
          user: capitalizedNewUser, 
          nfcUser: capitalizedNfcUser,
          timestamp: timestamp
        }
        );
      
      console.log(`Created/connected nodes with timestamp: ${timestamp} for ${capitalizedNewUser} -> ${capitalizedNfcUser}`);
      
      // Store the node name for focusing after mutation completes
      this.pendingNFCNode = nodeToFocus;
      
      // Trigger a single loadData call to reload the graph with the node
      await this.loadData(nodeToFocus, this.defaultQuery);
      
      // Wait for the state to be updated, then focus and auto-popup form
      let checkCount = 0;
      const waitForStateUpdate = () => {
        const nodeExists = this.state.data.nodes.find(n => n.name === nodeToFocus);
        checkCount++;
        
        if (nodeExists) {
          this.focusOnNewNode(nodeToFocus, this.state.data);
          this.pendingNFCNode = null;
          this.isNFCOperation = false;
          
          // Refresh timeline stats if in timeline mode
          this.refreshTimelineStats();
          
          // Auto-popup the form for the NFC node (whether new or existing)
          this.setState({ 
            nfcNodeForAutoPopup: nodeToFocus 
          });
        } else if (checkCount < 10) { // Limit retries to prevent infinite loops
          setTimeout(waitForStateUpdate, 500);
        } else {
          console.error("Failed to find node in state after multiple attempts");
          this.pendingNFCNode = null;
          this.isNFCOperation = false;
        }
      };
      
      // Start checking for state update after a short delay
      setTimeout(waitForStateUpdate, 1000);
      
    } catch (error) {
      console.error("Error adding user:", error);
      this.pendingNFCNode = null;
      this.isNFCOperation = false;
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

  // Timeline methods
  toggleTimelineMode = async () => {
    if (!this.state.timelineMode) {
      // Entering timeline mode - get timeline stats
      const stats = await this.getTimelineStats();
      
      // Stop breathing animation when entering timeline mode
      this.stopBreathingAnimation();
      
      // Ensure we have valid stats
      const validStats = stats || {
        earliest: new Date(Date.now() - 86400000), // 24 hours ago
        latest: new Date()
      };
      
      this.setState(prevState => ({
        timelineMode: true,
        timelineDate: validStats.latest,
        timelineData: prevState.data,
        timelineStats: validStats
      }));
    } else {
      // Exiting timeline mode
      this.setState({
        timelineMode: false,
        timelineDate: null,
        timelineData: null,
        timelineStats: null
      });
      
      // Restart breathing animation if user is idle
      if (!this.state.isUserActive) {
        this.startBreathingAnimation();
      }
    }
  };

  loadTimelineData = async (date) => {
    if (!this.driver) return;

    const session = this.driver.session();
    try {
      const timestamp = date.getTime();
      

      
      // Query for nodes and relationships that existed at the given timestamp
      const result = await session.run(
        `MATCH (u:User)
         WHERE u.createdAt IS NOT NULL AND u.createdAt <= $timestamp
         OPTIONAL MATCH (u)-[r:CONNECTED_TO]->(v:User)
         WHERE v.createdAt IS NOT NULL AND v.createdAt <= $timestamp
         AND r.createdAt IS NOT NULL AND r.createdAt <= $timestamp
         RETURN u.name AS source, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite,
                v.name AS target, v.role AS targetRole, v.location AS targetLocation, v.website AS targetWebsite`,
        { timestamp }
      );

      const nodes = new Set();
      const links = [];

      result.records.forEach(record => {
        const source = record.get('source');
        const target = record.get('target');
        const sourceRole = record.get('sourceRole');
        const targetRole = record.get('targetRole');
        const sourceLocation = record.get('sourceLocation');
        const targetLocation = record.get('targetLocation');
        const sourceWebsite = record.get('sourceWebsite');
        const targetWebsite = record.get('targetWebsite');

        // Always add the source node
        nodes.add(source);
        
        // Add target node and link only if there's a relationship
        if (target) {
          nodes.add(target);
          links.push({
            source,
            target,
            sourceRole,
            targetRole,
            sourceLocation,
            targetLocation,
            sourceWebsite,
            targetWebsite
          });
        }
      });

      const timelineData = {
        nodes: Array.from(nodes).map(name => ({ name })),
        links
      };



      this.setState({
        timelineData,
        timelineDate: date
      });

    } catch (error) {
      console.error('Error loading timeline data:', error);
    } finally {
      session.close();
    }
  };

  updateTimelineDate = (date) => {
    this.loadTimelineData(date);
  };

  getTimelineStats = async () => {
    if (!this.driver) return null;

    const session = this.driver.session();
    try {
      // Get the earliest and latest timestamps, prioritizing relationships for start time
      const result = await session.run(
        `MATCH ()-[r:CONNECTED_TO]->()
         WHERE r.createdAt IS NOT NULL
         RETURN min(r.createdAt) as earliest, max(r.createdAt) as latest`
      );

      if (result.records.length > 0) {
        const record = result.records[0];
        const earliest = record.get('earliest');
        const latest = record.get('latest');
        

        
        // Helper function to validate and convert timestamp
        const convertTimestamp = (timestamp) => {
          if (!timestamp) return null;
          
          // Convert to number if it's a string
          let numTimestamp = Number(timestamp);
          
          // Check if it's a valid timestamp (between 1970 and 2100)
          const minValid = new Date('1970-01-01').getTime();
          const maxValid = new Date('2100-01-01').getTime();
          
          // Try as milliseconds first
          if (numTimestamp >= minValid && numTimestamp <= maxValid) {
            return new Date(numTimestamp);
          }
          
          // Try as seconds (multiply by 1000)
          const secondsTimestamp = numTimestamp * 1000;
          if (secondsTimestamp >= minValid && secondsTimestamp <= maxValid) {
            return new Date(secondsTimestamp);
          }
          
          // If it's not a valid timestamp, return null
          return null;
        };
        
        const earliestDate = convertTimestamp(earliest);
        const latestDate = convertTimestamp(latest);
        
        const stats = {
          earliest: earliestDate || new Date(Date.now() - 86400000), // Default to 24 hours ago
          latest: latestDate || new Date()
        };
        
        return stats;
      }
    } catch (error) {
      console.error('Error getting timeline stats:', error);
    } finally {
      session.close();
    }
    return null;
  };

  resetToCurrentTime = () => {
    this.setState({
      timelineMode: false,
      timelineDate: null,
      timelineData: null
    });
  };

  // Refresh timeline stats when new nodes are added
  refreshTimelineStats = async () => {
    if (this.state.timelineMode) {
      const stats = await this.getTimelineStats();
      
      // Ensure timeline date stays within valid range
      let newTimelineDate = this.state.timelineDate;
      if (stats && this.state.timelineDate) {
        if (this.state.timelineDate.getTime() > stats.latest.getTime()) {
          newTimelineDate = stats.latest;
        } else if (this.state.timelineDate.getTime() < stats.earliest.getTime()) {
          newTimelineDate = stats.earliest;
        }
      }
      
      this.setState({ 
        timelineStats: stats,
        timelineDate: newTimelineDate
      });
      
      // Reload timeline data if date changed
      if (newTimelineDate && newTimelineDate.getTime() !== this.state.timelineDate?.getTime()) {
        this.loadTimelineData(newTimelineDate);
      }
    }
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
        timelineMode={this.state.timelineMode}
        timelineDate={this.state.timelineDate}
        timelineData={this.state.timelineData}
        timelineStats={this.state.timelineStats}
        toggleTimelineMode={this.toggleTimelineMode}
        loadTimelineData={this.loadTimelineData}
        updateTimelineDate={this.updateTimelineDate}
        resetToCurrentTime={this.resetToCurrentTime}
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
      // Generate a unique identifier for the person tapping the NFC tag
      // This could be based on device info, session, or a random ID
      const newUser = `User-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log(`NFC Trigger: Starting NFC operation for ${username} with visitor ${newUser}`);

      try {
        await addNode(newUser, username); // newUser = visitor, username = NFC tag owner
        console.log(`NFC Trigger: addNode completed successfully`);
        } catch (error) {
          console.error("NFC Trigger: Error adding user:", error);
          return;
        }

        setTimeout(() => {
          window.location.assign("/MITNet/#/");
          }, 2000);
        };

        addAndRedirect();
        }, [location, username]);

        return <div style={{ textAlign: "center", padding: "20px", fontSize: "16px", color: "red" }}>Adding you to {username}'s network...</div>
      };

              const GraphView = ({ data, handleChange, loadData, fgRef, latestNode, pollingFocusNode, driver, processingMutation, updateUserActivity, isUserActive, scaleTransitionStart, scaleTransitionDuration, nfcNodeForAutoPopup, onNfcPopupTriggered, timelineMode, timelineDate, timelineData, timelineStats, toggleTimelineMode, loadTimelineData, updateTimelineDate, resetToCurrentTime }) => {
        const [inputValue, setInputValue] = useState(""); 
        const [selectedNode, setSelectedNode] = useState(null);
        const [editedNode, setEditedNode] = useState(null);
        const [focusNode, setFocusNode] = useState(null);
        const [clickedNode, setClickedNode] = useState(null);
        const [lastAction, setLastAction] = useState(null); // 'search', 'click', 'latestNode', or 'mutation'
        const [mutatedNodes, setMutatedNodes] = useState([]); // Track nodes created/modified by mutation queries
        const [analyticalAnswer, setAnalyticalAnswer] = useState(null); // For displaying analytical answers
        const [showAnalyticalModal, setShowAnalyticalModal] = useState(false); // For showing/hiding the answer modal
        const [relationshipNote, setRelationshipNote] = useState(""); // For relationship notes when connecting to existing nodes
        const [nfcNameInput, setNfcNameInput] = useState("");
        const [nfcRoleInput, setNfcRoleInput] = useState(""); // For initial NFC name input
        const [showNfcNamePopup, setShowNfcNamePopup] = useState(false); // For showing NFC name input popup
        const [showProfilePopup, setShowProfilePopup] = useState(false); // For showing profile completion popup
        const [pendingNfcName, setPendingNfcName] = useState(""); // Store the name that was entered
        const [selectedLink, setSelectedLink] = useState(null); // For selected relationship/link
        const [relationshipData, setRelationshipData] = useState({}); // Store relationship data
        const [showNfcRelationshipPopup, setShowNfcRelationshipPopup] = useState(false);
        const [currentNfcConnection, setCurrentNfcConnection] = useState(null); // For NFC relationship note popup
        const [hoveredLink, setHoveredLink] = useState(null); // For link hover effects
        const [focusTimeout, setFocusTimeout] = useState(null); // Track focus timeout
        const [autoZoomTriggered, setAutoZoomTriggered] = useState(false); // Track if auto-zoom has been triggered

        // Detect when latestNode changes (NFC addition) and set lastAction
        useEffect(() => {
          if (latestNode) {
            setLastAction('latestNode');
            // Clear any existing focus timeouts when new visual states are set
            if (focusTimeout) {
              clearTimeout(focusTimeout);
              setFocusTimeout(null);
            }
            setAutoZoomTriggered(false); // Allow new auto-zoom for this latestNode
          }
        }, [latestNode, focusTimeout]);

        // Auto-popup form for NFC nodes
        useEffect(() => {
          if (nfcNodeForAutoPopup && data.nodes.length > 0) {
            // Find the NFC node in the data
            const nfcNode = data.nodes.find(node => node.name === nfcNodeForAutoPopup);
            if (nfcNode) {
              // Show the initial name input popup for NFC nodes
              setShowNfcNamePopup(true);
              setNfcNameInput("");
              setFocusNode(nfcNode.name);
              setClickedNode(nfcNode.name);
              setLastAction('latestNode');
              
              // Clear the nfcNodeForAutoPopup after triggering the popup
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
        
        // Auto-zoom to visible nodes with temporary focus behavior
        useEffect(() => {
          // Only run auto-zoom if it hasn't been triggered yet and we have a valid action
          if (autoZoomTriggered || !fgRef.current || !lastAction) {
            return;
          }
          
          // Clear any existing focus timeout
          if (focusTimeout) {
            clearTimeout(focusTimeout);
            setFocusTimeout(null);
          }
          
          // Mark that auto-zoom has been triggered
          setAutoZoomTriggered(true);
          
          // Only auto-zoom if there are nodes to zoom to
          if (zoomNodes.size > 0) {
            const performAutoZoom = () => {
              const visibleNodes = data.nodes.filter(node => zoomNodes.has(node.name));
              if (visibleNodes.length === 0) return;
              
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
              
              // Set temporary focus timeout to just reset the flag (no zoom out)
              const newFocusTimeout = setTimeout(() => {
                setFocusTimeout(null);
                setAutoZoomTriggered(false); // Reset the flag to allow future auto-zooms
              }, 1000);
              
              setFocusTimeout(newFocusTimeout);
            };
            
            // For latestNode and mutation, add a delay to allow graph to stabilize
            if (lastAction === 'latestNode' || lastAction === 'mutation') {
              setTimeout(performAutoZoom, 1000);
            } else {
              performAutoZoom();
            }
          } else {
            // If no nodes to zoom to, reset the flag immediately
            setAutoZoomTriggered(false);
          }
        }, [lastAction, clickedNode, latestNode, inputValue, mutatedNodes]); // Removed focusTimeout from dependencies

        // Cleanup focus timeout and reset flags on unmount
        useEffect(() => {
          return () => {
            if (focusTimeout) {
              clearTimeout(focusTimeout);
            }
            setAutoZoomTriggered(false);
          };
        }, [focusTimeout]);

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
            
            // Clear any existing focus timeouts when new visual states are set
            if (focusTimeout) {
              clearTimeout(focusTimeout);
              setFocusTimeout(null);
            }
            setAutoZoomTriggered(false); // Allow new auto-zoom for this search
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
            let generatedQuery = data.text || data.query || "";
            
            // Clean up the query by removing markdown code blocks if present
            generatedQuery = generatedQuery
              .replace(/```cypher\s*/gi, '')  // Remove opening cypher code block
              .replace(/```\s*$/gi, '')       // Remove closing code block
              .replace(/^```\s*/gi, '')       // Remove any opening code block
              .trim();                        // Remove extra whitespace

            // Detection for different types of requests
            const question = inputValue.toLowerCase();
            
            // Individual node report detection (check this FIRST)
            const isNodeReportRequest = (() => {
              console.log("Checking for node report request:", inputValue);
              const nodeReportPatterns = [
                /report.*(?:for|about|on)\s+([A-Za-z\s]+)/i,
                /(?:generate|create|show)\s+(?:a\s+)?report.*(?:for|about|on)\s+([A-Za-z\s]+)/i,
                /(?:analysis|summary)\s+(?:for|about|on)\s+([A-Za-z\s]+)/i,
                /([A-Za-z\s]+)\s+(?:report|analysis|summary)/i,
                /(?:report|analysis|summary)\s+for\s+([A-Za-z\s]+)/i
              ];
              
              for (const pattern of nodeReportPatterns) {
                const match = question.match(pattern);
                if (match && match[1]) {
                  const name = match[1].trim();
                  // Filter out common words and action verbs that might be captured
                  const excludedWords = [
                    'the', 'and', 'or', 'for', 'about', 'on', 'generate', 'create', 'show', 
                    'analysis', 'summary', 'report', 'network', 'comprehensive', 'full'
                  ];
                  if (name.length > 2 && !excludedWords.includes(name.toLowerCase())) {
                    // Additional check: make sure it looks like a person's name (contains space or is a single word)
                    if (name.includes(' ') || name.length > 3) {
                      console.log("Node report detected for:", name);
                      return name;
                    }
                  }
                }
              }
              return null;
            })();

            // Report request detection (check this SECOND)
            const isReportRequest = (() => {
              const reportKeywords = [
                'report', 'analysis', 'summary', 'network analysis', 'bridge analysis', 
                'top connectors', 'network health', 'generate report', 'comprehensive report', 
                'full analysis', 'network report', 'bridge report', 'connector analysis'
              ];
              return reportKeywords.some(keyword => question.includes(keyword));
            })();

            // More specific detection for true analytical questions vs visualization requests
            const isTrueAnalyticalQuestion = (() => {
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

            if (isNodeReportRequest) {
              // For individual node report requests
              try {
                const nodeName = isNodeReportRequest;
                console.log("Generating node report for:", nodeName);
                
                const session = driver.session({ database: "neo4j" });
                
                // Query for the specific node and its connections
                const nodeQuery = `
                  MATCH (u:User)
                  WHERE toLower(u.name) = toLower($nodeName)
                  OPTIONAL MATCH (u)-[r:CONNECTED_TO]->(v:User)
                  RETURN u.name AS sourceName, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite,
                         v.name AS targetName, v.role AS targetRole, v.location AS targetLocation, v.website AS targetWebsite,
                         r.note AS connectionNote, r.createdAt AS connectionTime
                  UNION
                  MATCH (v:User)-[r:CONNECTED_TO]->(u:User)
                  WHERE toLower(u.name) = toLower($nodeName)
                  RETURN v.name AS sourceName, v.role AS sourceRole, v.location AS sourceLocation, v.website AS sourceWebsite,
                         u.name AS targetName, u.role AS targetRole, u.location AS targetLocation, u.website AS targetWebsite,
                         r.note AS connectionNote, r.createdAt AS connectionTime
                  UNION
                  MATCH (u:User)
                  WHERE toLower(u.name) = toLower($nodeName)
                  AND NOT EXISTS((u)-[:CONNECTED_TO]->())
                  AND NOT EXISTS(()-[:CONNECTED_TO]->(u))
                  RETURN u.name AS sourceName, u.role AS sourceRole, u.location AS sourceLocation, u.website AS sourceWebsite,
                         null AS targetName, null AS targetRole, null AS targetLocation, null AS targetWebsite,
                         null AS connectionNote, null AS connectionTime
                `;
                
                let result = await session.run(nodeQuery, { nodeName });
                console.log("Node query result:", result.records.length, "records");
                if (result.records.length > 0) {
                  console.log("First record:", result.records[0].toObject());
                }
                
                // If no results, try a fuzzy search
                if (result.records.length === 0) {
                  console.log("No exact match found, trying fuzzy search...");
                  const fuzzyQuery = `
                    MATCH (u:User)
                    WHERE toLower(u.name) CONTAINS toLower($nodeName)
                    RETURN u.name AS name, u.role AS role, u.location AS location
                    LIMIT 5
                  `;
                  const fuzzyResult = await session.run(fuzzyQuery, { nodeName });
                  
                  if (fuzzyResult.records.length > 0) {
                    const suggestions = fuzzyResult.records.map(record => record.get('name')).join(', ');
                    await session.close();
                    displayNetworkReport(`No exact match found for "${nodeName}". Did you mean one of these?\n\n${suggestions}\n\nPlease try with the exact name.`, `Name Not Found: ${nodeName}`);
                    return;
                  }
                }
                
                await session.close();

                // Generate a node-specific report
                const report = generateNodeReport(result, nodeName, inputValue);
                
                // Display the report in a modal
                displayNetworkReport(report, `Node Analysis: ${nodeName}`);
                
                // Clear the input after showing the report
                setTimeout(() => {
                  setInputValue("");
                }, 10000);
                
              } catch (queryError) {
                console.error("Error generating node report:", queryError);
                displayNetworkReport(`Sorry, I couldn't generate a report for that person. Please check the name and try again.`, inputValue);
              }
            } else if (isReportRequest) {
              // For general report requests, execute the query and generate a comprehensive report
              try {
                const session = driver.session({ database: "neo4j" });
                const result = await session.run(generatedQuery);
                await session.close();

                // Generate a comprehensive network analysis report
                const report = generateNetworkReport(result, inputValue);
                
                // Display the report in a modal or notification
                displayNetworkReport(report, inputValue);
                
                // Clear the input after showing the report
                setTimeout(() => {
                  setInputValue("");
                }, 10000); // Keep report visible longer
                
              } catch (queryError) {
                console.error("Error generating report:", queryError);
                displayNetworkReport("Sorry, I couldn't generate the report. Please try again.", inputValue);
              }
            } else if (isTrueAnalyticalQuestion) {
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
                
                // Clear any existing focus timeouts when new visual states are set
                if (focusTimeout) {
                  clearTimeout(focusTimeout);
                  setFocusTimeout(null);
                }
                setAutoZoomTriggered(false); // Allow new auto-zoom for this mutation
                
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

        // Helper function to check if a node is new (created via NFC)
        const isNewNode = (node) => {
          return node.name === latestNode;
        };

        const handleNodeClick = (node) => {
          if (!node) return;
          setSelectedNode(node);
          setEditedNode({ ...node });
          setFocusNode(node.name);
          setClickedNode(node.name);
          setLastAction('click');
          
          // Clear relationship note when clicking a different node
          setRelationshipNote("");
          
          // Update user activity when clicking nodes
          updateUserActivity();
          
          // Clear search when clicking a node to avoid zoom conflicts
          setInputValue("");
          
          // Clear any existing focus timeout and reset auto-zoom flag
          if (focusTimeout) {
            clearTimeout(focusTimeout);
            setFocusTimeout(null);
          }
          setAutoZoomTriggered(false); // Allow new auto-zoom for this click
        };

        const handleNodeHover = (node) => {
          if (node) {
            setFocusNode(node.name);
          } else {
            setFocusNode(null);
          }
        };

        const handleLinkClick = async (link) => {
          if (!link) return;
          
          const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
          const targetName = typeof link.target === 'object' ? link.target.name : link.target;
          
          console.log(`Link clicked: ${sourceName} -> ${targetName}`);
          
          const session = driver.session();
          try {
            // Get relationship data including notes
            const relationshipResult = await session.run(
              `MATCH (source:User {name: $sourceName})-[r:CONNECTED_TO]->(target:User {name: $targetName})
               RETURN r.note as note, source.name as sourceName, target.name as targetName`,
              { sourceName: sourceName, targetName: targetName }
            );
            
            if (relationshipResult.records.length > 0) {
              const record = relationshipResult.records[0];
              const note = record.get('note');
              
              setSelectedLink(link);
              setRelationshipData({
                sourceName: sourceName,
                targetName: targetName,
                note: note
              });
              
              console.log(`Relationship data: ${sourceName} -> ${targetName}, Note: ${note}`);
            }
          } catch (error) {
            console.error("Error fetching relationship data:", error);
          } finally {
            session.close();
          }
        };

        const handleLinkHover = async (link) => {
          if (!link) {
            setHoveredLink(null);
            return;
          }
          
          const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
          const targetName = typeof link.target === 'object' ? link.target.name : link.target;
          
          const session = driver.session();
          try {
            // Get relationship data including notes
            const relationshipResult = await session.run(
              `MATCH (source:User {name: $sourceName})-[r:CONNECTED_TO]->(target:User {name: $targetName})
               RETURN r.note as note, source.name as sourceName, target.name as targetName`,
              { sourceName: sourceName, targetName: targetName }
            );
            
            if (relationshipResult.records.length > 0) {
              const record = relationshipResult.records[0];
              const note = record.get('note');
              
              setHoveredLink({
                link: link,
                sourceName: sourceName,
                targetName: targetName,
                note: note
              });
            }
          } catch (error) {
            console.error("Error fetching relationship data:", error);
          } finally {
            session.close();
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

          const newName = capitalizeWords(editedNode.name);
          const oldName = selectedNode.name;

          // Don't do anything if the name hasn't changed
          if (newName === oldName) {
            setSelectedNode(null); // Close the panel
            return;
          }

          const session = driver.session();
          try {
            // First, check if a node with the new name already exists
            const existingNodeCheck = await session.run(
              `MATCH (u:User {name: $newName}) RETURN u`,
              { newName: newName }
            );

            if (existingNodeCheck.records.length > 0) {
              // A node with the new name already exists - merge them
              console.log(`Node with name "${newName}" already exists, merging with existing node...`);
              
              // Get the existing node's properties
              const existingNode = existingNodeCheck.records[0].get('u').properties;
              
              // Merge properties: keep non-empty values from either node
              const mergedRole = existingNode.role && existingNode.role !== '' ? existingNode.role : editedNode.role;
              const mergedLocation = existingNode.location && existingNode.location !== '' ? existingNode.location : editedNode.location;
              const mergedWebsite = existingNode.website && existingNode.website !== '' ? existingNode.website : editedNode.website;
              
              // Efficiently merge all relationships and delete old node in a single operation
              await session.run(
                `MATCH (old:User {name: $oldName})
                 OPTIONAL MATCH (old)-[r1:CONNECTED_TO]->(other1)
                 OPTIONAL MATCH (other2)-[r2:CONNECTED_TO]->(old)
                 WITH old, collect(DISTINCT other1) as outgoing, collect(DISTINCT other2) as incoming
                 MATCH (existing:User {name: $newName})
                 
                 // Create outgoing relationships (avoiding self-connections and duplicates)
                 FOREACH (other IN outgoing |
                   FOREACH (x IN CASE WHEN other.name <> $newName AND NOT EXISTS((existing)-[:CONNECTED_TO]->(other)) THEN [1] ELSE [] END |
                     CREATE (existing)-[r:CONNECTED_TO]->(other)
                     SET r.createdAt = $timestamp
                   )
                 )
                 
                 // Create incoming relationships (avoiding self-connections and duplicates)
                 FOREACH (other IN incoming |
                   FOREACH (x IN CASE WHEN other.name <> $newName AND NOT EXISTS((other)-[:CONNECTED_TO]->(existing)) THEN [1] ELSE [] END |
                     CREATE (other)-[r:CONNECTED_TO]->(existing)
                     SET r.createdAt = $timestamp
                   )
                 )
                 
                 // Delete the old node
                 DETACH DELETE old`,
                { oldName: oldName, newName: newName, timestamp: Date.now() }
              );
              
              // Update the existing node with merged properties
              await session.run(
                `MATCH (u:User {name: $newName})
                 SET u.role = $role, u.location = $location, u.website = $website`,
                {
                  newName: newName,
                  role: mergedRole,
                  location: mergedLocation,
                  website: mergedWebsite
                }
              );
              
              console.log(`Successfully merged nodes. New node "${newName}" has properties:`, { mergedRole, mergedLocation, mergedWebsite });
              
              // Focus on the merged node
              await loadData(newName);
              setSelectedNode(null); // Close the panel
            } else {
              // No existing node with the new name, just update the current node
            await session.run(
              `MATCH (u:User {name: $oldName}) 
              SET u.name = $newName`,
                {
                  oldName: oldName,
                  newName: newName,
                }
              );
              await loadData(newName); // Keep the edited node as latestNode
              setSelectedNode(null); // Close the panel
            }
          } catch (error) {
            console.error("Error updating node:", error);
          } finally {
            session.close();
          }
        };

        const saveNewNodeProfile = async () => {
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
              SET u.name = $newName, u.role = $role, u.location = $location, u.website = $website`,
              {
                oldName: selectedNode.name,
                newName: capitalizeWords(editedNode.name),
                role: editedNode.role || '',
                location: editedNode.location || '',
                website: editedNode.website || ''
              }
            );
            await loadData(capitalizeWords(editedNode.name));
            setSelectedNode(null); // Close the panel
          } catch (error) {
            console.error("Error updating new node profile:", error);
          } finally {
            session.close();
          }
        };

        const saveRelationshipNote = async () => {
          if (!selectedNode || !relationshipNote.trim()) return;

          const session = driver.session();
          try {
            let sourceName, targetName;
            
            if (showNfcRelationshipPopup) {
              // This is an NFC operation - use the tracked connection
              if (currentNfcConnection) {
                sourceName = currentNfcConnection.source;
                targetName = currentNfcConnection.target;
              } else {
                // Fallback: try to find the connection
                const fallbackResult = await session.run(
                  `MATCH (source:User)-[r:CONNECTED_TO]->(target:User {name: $holderName})
                   RETURN source.name as sourceName, target.name as targetName
                   ORDER BY source.name DESC
                   LIMIT 1`,
                  { holderName: selectedNode.name }
                );
                
                if (fallbackResult.records.length > 0) {
                  const record = fallbackResult.records[0];
                  sourceName = record.get('sourceName');
                  targetName = record.get('targetName');
                }
              }
            } else {
              // This is a regular relationship note - use the existing logic
              const nfcHolderResult = await session.run(
                `MATCH (existing:User {name: $existingName})-[r:CONNECTED_TO]->(holder:User)
                 RETURN holder.name as holderName`,
                { existingName: selectedNode.name }
              );
              
              const nfcHolderName = nfcHolderResult.records[0]?.get('holderName');
              
              if (nfcHolderName) {
                sourceName = selectedNode.name;
                targetName = nfcHolderName;
              }
            }
            
            if (sourceName && targetName) {
              // Add the relationship note as a property to the connection
              const updateResult = await session.run(
                `MATCH (source:User {name: $sourceName})-[r:CONNECTED_TO]->(target:User {name: $targetName})
                 SET r.note = $note
                 RETURN r.note as updatedNote`,
                {
                  sourceName: sourceName,
                  targetName: targetName,
                  note: relationshipNote.trim()
                }
              );
              
              if (updateResult.records.length > 0) {
                const updatedNote = updateResult.records[0].get('updatedNote');
              }
            }
            
            setSelectedNode(null); // Close the panel
            setRelationshipNote(""); // Clear the note
            setPendingNfcName(""); // Clear pending name
            setShowNfcRelationshipPopup(false); // Close NFC relationship popup
            setCurrentNfcConnection(null); // Clear the tracked connection
          } catch (error) {
            console.error("Error saving relationship note:", error);
          } finally {
            session.close();
          }
        };

        const handleNfcNameSubmit = async () => {
          if (!nfcNameInput.trim()) return;

          // Helper function to capitalize first letter of each word
          const capitalizeWords = (str) => {
            if (!str) return str;
            return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
          };

          const capitalizedName = capitalizeWords(nfcNameInput.trim());
          setPendingNfcName(capitalizedName);

          const session = driver.session();
          try {
            // Check if a node with this name already exists
            const existingNodeCheck = await session.run(
              `MATCH (u:User {name: $name}) RETURN u`,
              { name: capitalizedName }
            );

            if (existingNodeCheck.records.length > 0) {
              // Node exists - merge visitor into existing node and show connection note popup
              console.log(`Node "${capitalizedName}" exists, merging visitor into existing node`);
              
              const existingNode = existingNodeCheck.records[0].get('u').properties;
              
              // Get the NFC holder name from the visitor's connection
              const nfcHolderResult = await session.run(
                `MATCH (visitor:User {name: $visitorName})-[r:CONNECTED_TO]->(holder:User)
                 RETURN holder.name as holderName`,
                { visitorName: latestNode }
              );
              
              const nfcHolderName = nfcHolderResult.records[0]?.get('holderName');
              
              if (nfcHolderName) {
                // Store the connection details for the relationship note
                setCurrentNfcConnection({
                  source: capitalizedName,
                  target: nfcHolderName
                });
                
                // Check if the existing node is already connected to the NFC holder
                const existingConnectionCheck = await session.run(
                  `MATCH (existing:User {name: $existingName})-[r:CONNECTED_TO]->(holder:User {name: $holderName})
                   RETURN r`,
                  { existingName: capitalizedName, holderName: nfcHolderName }
                );
                
                if (existingConnectionCheck.records.length === 0) {
                  // No existing connection, create one
                  await session.run(
                    `MATCH (existing:User {name: $existingName}), (holder:User {name: $holderName})
                     CREATE (existing)-[r:CONNECTED_TO]->(holder)
                     SET r.createdAt = $timestamp`,
                    { existingName: capitalizedName, holderName: nfcHolderName, timestamp: Date.now() }
                  );
                  console.log(`Created new connection from "${capitalizedName}" to "${nfcHolderName}"`);
                } else {
                  console.log(`Connection from "${capitalizedName}" to "${nfcHolderName}" already exists`);
                }
                
                // Delete the visitor node
                await session.run(
                  `MATCH (visitor:User {name: $visitorName})
                   DETACH DELETE visitor`,
                  { visitorName: latestNode }
                );
                
                console.log(`Merged visitor into existing node "${capitalizedName}"`);
              }
              
              setShowNfcNamePopup(false);
              setNfcNameInput("");
              setNfcRoleInput("");
              setSelectedNode(existingNode);
              setRelationshipNote("");
              setShowNfcRelationshipPopup(true); // Show NFC relationship note popup
              
              // Don't reload data to avoid triggering duplicate cleanup again
              // Just focus on the existing node
              console.log(`Merged visitor into existing node "${capitalizedName}", focusing on existing node`);
              
              // Update the latestNode to the existing node so it gets focused
              // We'll let the user manually refresh if needed
            } else {
              // Node doesn't exist - show profile completion popup
              console.log(`Node "${capitalizedName}" doesn't exist, showing profile completion popup`);
              setShowNfcNamePopup(false);
              setNfcNameInput("");
              setNfcRoleInput("");
              setShowProfilePopup(true);
              setSelectedNode({ name: capitalizedName, role: nfcRoleInput, location: "", website: "" });
              setEditedNode({ name: capitalizedName, role: nfcRoleInput, location: "", website: "" });
            }
          } catch (error) {
            console.error("Error checking for existing node:", error);
          } finally {
            session.close();
          }
        };

        const saveNewProfileFromNfc = async () => {
          if (!editedNode || !pendingNfcName) return;

          const session = driver.session();
          try {
            // Update the visitor node with the new name and profile information
            await session.run(
              `MATCH (visitor:User {name: $visitorName}) 
               SET visitor.name = $newName, visitor.role = $role, visitor.location = $location, visitor.website = $website`,
              {
                visitorName: latestNode,
                newName: editedNode.name,
                role: editedNode.role || '',
                location: editedNode.location || '',
                website: editedNode.website || ''
              }
            );
            
            console.log(`Updated visitor profile: ${editedNode.name} with role: ${editedNode.role}, location: ${editedNode.location}, website: ${editedNode.website}`);
            setShowProfilePopup(false);
            
            // Get the NFC holder name from the visitor's connection
            const nfcHolderResult = await session.run(
              `MATCH (visitor:User {name: $visitorName})-[r:CONNECTED_TO]->(holder:User)
               RETURN holder.name as holderName`,
              { visitorName: editedNode.name }
            );
            
            const nfcHolderName = nfcHolderResult.records[0]?.get('holderName');
            
            if (nfcHolderName) {
              // Store the connection details for the relationship note
              setCurrentNfcConnection({
                source: editedNode.name,
                target: nfcHolderName
              });
              
              // Show connection note popup for the new user
              setSelectedNode({ name: nfcHolderName, role: "", location: "", website: "" });
              setRelationshipNote("");
              setShowNfcRelationshipPopup(true);
            } else {
              // No NFC holder found, just close the popup
              setSelectedNode(null);
              setEditedNode(null);
              setPendingNfcName("");
              setCurrentNfcConnection(null);
            }
            
            // Reload data to show the updated node
            await loadData(editedNode.name);
          } catch (error) {
            console.error("Error saving new profile from NFC:", error);
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
            } else if (questionLower.includes('program')) {
              return `There are ${count} program.`;
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

        // Helper function to generate comprehensive network analysis reports
        const generateNetworkReport = (result, question) => {
          const records = result.records;
          
          if (records.length === 0) {
            return "No network data found to analyze.";
          }

          // Parse the network data
          const connections = [];
          const users = new Map();
          const userConnections = new Map();

          records.forEach(record => {
            const sourceName = record.get('sourceName');
            const sourceRole = record.get('sourceRole');
            const sourceLocation = record.get('sourceLocation');
            const targetName = record.get('targetName');
            const targetRole = record.get('targetRole');
            const targetLocation = record.get('targetLocation');
            const connectionNote = record.get('connectionNote');
            const connectionTime = record.get('connectionTime');

            // Add users to the map
            if (sourceName) {
              users.set(sourceName, {
                name: sourceName,
                role: sourceRole,
                location: sourceLocation
              });
            }
            if (targetName) {
              users.set(targetName, {
                name: targetName,
                role: targetRole,
                location: targetLocation
              });
            }

            // Count connections per user
            if (sourceName && targetName) {
              userConnections.set(sourceName, (userConnections.get(sourceName) || 0) + 1);
              userConnections.set(targetName, (userConnections.get(targetName) || 0) + 1);
              
              connections.push({
                source: sourceName,
                target: targetName,
                note: connectionNote,
                time: connectionTime
              });
            }
          });

          // Find top connectors
          const topConnectors = Array.from(userConnections.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));

          // Analyze demographics
          const locations = Array.from(users.values()).map(u => u.location).filter(Boolean);
          const uniqueLocations = [...new Set(locations)];
          const roles = Array.from(users.values()).map(u => u.role).filter(Boolean);
          const uniqueRoles = [...new Set(roles)];

          // Generate the report
          const report = `# 📊 **Network Analysis Report**

## **🎯 Executive Summary**
- **Total Users**: ${users.size}
- **Total Connections**: ${connections.length}
- **Top Connector**: ${topConnectors[0]?.name || 'N/A'} (${topConnectors[0]?.count || 0} connections)
- **Network Health**: ${connections.length > users.size * 2 ? 'Excellent' : connections.length > users.size ? 'Good' : 'Needs Improvement'}

## **🏆 Top Network Connectors**
${topConnectors.slice(0, 5).map((connector, index) => 
  `${index + 1}. **${connector.name}** - ${connector.count} connections`
).join('\n')}

## **🌍 Demographics & Participation**
- **Geographic Diversity**: ${uniqueLocations.length} unique locations
- **Professional Diversity**: ${uniqueRoles.length} unique roles
- **Participation Rate**: ${Math.round((connections.length / (users.size * (users.size - 1) / 2)) * 100)}% of possible connections

## **📈 Network Statistics**
| Metric | Value |
|--------|-------|
| **Total Users** | ${users.size} |
| **Total Connections** | ${connections.length} |
| **Average Connections per User** | ${Math.round(connections.length / users.size * 2)} |
| **Unique Locations** | ${uniqueLocations.length} |
| **Unique Roles** | ${uniqueRoles.length} |

## **💡 Key Insights**
- The network shows ${connections.length > users.size * 2 ? 'strong' : connections.length > users.size ? 'moderate' : 'limited'} connectivity
- Top connectors demonstrate effective networking skills
- Geographic and professional diversity enhance network value

## **🎯 Recommendations**
- Encourage more connections between different communities
- Support bridge nodes to maintain network resilience
- Foster cross-cultural and cross-professional connections`;

          return report;
        };

        // Helper function to generate individual node analysis reports
        const generateNodeReport = (result, nodeName, question) => {
          const records = result.records;
          
          console.log("generateNodeReport called with:", { nodeName, recordCount: records.length });
          
          if (records.length === 0) {
            return `No data found for ${nodeName}. Please check the name and try again.`;
          }

          // Parse the node data
          const connections = [];
          const nodeInfo = {};
          const connectedUsers = new Map();

          records.forEach((record, index) => {
            const sourceName = record.get('sourceName');
            const sourceRole = record.get('sourceRole');
            const sourceLocation = record.get('sourceLocation');
            const sourceWebsite = record.get('sourceWebsite');
            const targetName = record.get('targetName');
            const targetRole = record.get('targetRole');
            const targetLocation = record.get('targetLocation');
            const targetWebsite = record.get('targetWebsite');
            const connectionNote = record.get('connectionNote');
            const connectionTime = record.get('connectionTime');
            
            console.log(`Record ${index}:`, { sourceName, targetName, nodeName });

            // Store node info (case-insensitive comparison)
            if (sourceName && sourceName.toLowerCase() === nodeName.toLowerCase()) {
              nodeInfo.name = sourceName;
              nodeInfo.role = sourceRole;
              nodeInfo.location = sourceLocation;
              nodeInfo.website = sourceWebsite;
              console.log("Found node info from source:", { name: sourceName, role: sourceRole, location: sourceLocation });
            } else if (targetName && targetName.toLowerCase() === nodeName.toLowerCase()) {
              nodeInfo.name = targetName;
              nodeInfo.role = targetRole;
              nodeInfo.location = targetLocation;
              nodeInfo.website = targetWebsite;
              console.log("Found node info from target:", { name: targetName, role: targetRole, location: targetLocation });
            }

            // Count connections
            if (sourceName && targetName && sourceName !== targetName) {
              const otherPerson = sourceName === nodeName ? targetName : sourceName;
              const otherRole = sourceName === nodeName ? targetRole : sourceRole;
              const otherLocation = sourceName === nodeName ? targetLocation : sourceLocation;
              
              connectedUsers.set(otherPerson, {
                name: otherPerson,
                role: otherRole,
                location: otherLocation,
                note: connectionNote,
                time: connectionTime
              });
              
              connections.push({
                source: sourceName,
                target: targetName,
                note: connectionNote,
                time: connectionTime
              });
            }
          });

          // Analyze connections
          const totalConnections = connectedUsers.size;
          const roles = Array.from(connectedUsers.values()).map(u => u.role).filter(Boolean);
          const uniqueRoles = [...new Set(roles)];
          const locations = Array.from(connectedUsers.values()).map(u => u.location).filter(Boolean);
          const uniqueLocations = [...new Set(locations)];

          // Find most common connections
          const roleCounts = {};
          roles.forEach(role => {
            roleCounts[role] = (roleCounts[role] || 0) + 1;
          });
          const topRoles = Object.entries(roleCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);

          const locationCounts = {};
          locations.forEach(location => {
            locationCounts[location] = (locationCounts[location] || 0) + 1;
          });
          const topLocations = Object.entries(locationCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);

          console.log("Final nodeInfo:", nodeInfo);
          
          // Generate the report
          const report = `# 👤 **Individual Network Analysis: ${nodeName}**

## **🎯 Profile Summary**
- **Name**: ${nodeInfo.name || 'N/A'}
- **Role**: ${nodeInfo.role || 'N/A'}
- **Location**: ${nodeInfo.location || 'N/A'}
- **Website**: ${nodeInfo.website || 'N/A'}
- **Total Connections**: ${totalConnections}

## **🔗 Connection Analysis**
- **Network Reach**: ${totalConnections} direct connections
- **Role Diversity**: ${uniqueRoles.length} different professional roles
- **Geographic Reach**: ${uniqueLocations.length} different locations

## **📊 Top Connection Categories**

### **Most Connected Roles**
${topRoles.map(([role, count]) => 
  `- **${role}**: ${count} connections`
).join('\n')}

### **Most Connected Locations**
${topLocations.map(([location, count]) => 
  `- **${location}**: ${count} connections`
).join('\n')}

## **🌍 Network Diversity**
- **Professional Diversity**: ${uniqueRoles.length} unique roles
- **Geographic Diversity**: ${uniqueLocations.length} unique locations
- **Connection Quality**: ${connections.filter(c => c.note).length} connections with notes

## **💡 Key Insights**
- ${nodeName} is a ${totalConnections > 20 ? 'super connector' : totalConnections > 10 ? 'active networker' : 'moderate connector'}
- ${uniqueRoles.length > 3 ? 'High professional diversity' : 'Moderate professional diversity'} in connections
- ${uniqueLocations.length > 5 ? 'Strong geographic reach' : 'Local to regional focus'} in networking

## **🎯 Network Impact**
- **Bridge Potential**: ${uniqueRoles.length > 2 && uniqueLocations.length > 3 ? 'High - connects diverse communities' : 'Moderate - focused connections'}
- **Information Flow**: ${totalConnections > 15 ? 'Excellent - high connectivity' : totalConnections > 8 ? 'Good - moderate connectivity' : 'Limited - few connections'}
- **Resource Sharing**: ${uniqueRoles.length > 2 ? 'Strong - diverse professional network' : 'Focused - similar professional backgrounds'}`;

          return report;
        };

        // Helper function to display network reports
        const displayNetworkReport = (report, question) => {
          // Format the report with better styling
          const formattedReport = report
            .replace(/# 📊 \*\*Network Analysis Report\*\*/g, '<h1 style="color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; margin-bottom: 20px;">📊 Network Analysis Report</h1>')
            .replace(/## \*\*🎯 Executive Summary\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">🎯 Executive Summary</h2>')
            .replace(/## \*\*🏆 Top Network Connectors\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">🏆 Top Network Connectors</h2>')
            .replace(/## \*\*🌍 Demographics & Participation\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">🌍 Demographics & Participation</h2>')
            .replace(/## \*\*📈 Network Statistics\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">📈 Network Statistics</h2>')
            .replace(/## \*\*💡 Key Insights\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">💡 Key Insights</h2>')
            .replace(/## \*\*🎯 Recommendations\*\*/g, '<h2 style="color: #34495e; background: #ecf0f1; padding: 10px; border-radius: 5px; margin: 20px 0 15px 0;">🎯 Recommendations</h2>')
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #e74c3c;">$1</strong>')
            .replace(/- \*\*(.*?)\*\*: (.*?)$/gm, '<li style="margin: 8px 0; padding: 5px 0; border-left: 3px solid #3498db; padding-left: 15px;"><strong style="color: #e74c3c;">$1</strong>: $2</li>')
            .replace(/(\d+)\. \*\*(.*?)\*\* - (\d+) connections/g, '<li style="margin: 8px 0; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 4px solid #27ae60;"><strong style="color: #e74c3c;">$2</strong> - <span style="color: #27ae60; font-weight: bold;">$3 connections</span></li>')
            .replace(/\| (.*?) \| (.*?) \|/g, '<tr><td style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; font-weight: bold;">$1</td><td style="padding: 8px; border: 1px solid #ddd; text-align: center;">$2</td></tr>')
            .replace(/\|--------\|-------\|/g, '')
            .replace(/- (.*?)$/gm, '<li style="margin: 5px 0; padding: 3px 0;">$1</li>');

          // Wrap in proper HTML structure
          const htmlReport = `
            <div style="
              max-height: 70vh; 
              overflow-y: auto; 
              padding: 20px; 
              background: white; 
              border-radius: 8px; 
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              line-height: 1.6;
              color: #2c3e50;
            ">
              <div style="margin-bottom: 20px;">
                ${formattedReport}
              </div>
            </div>
          `;

          setAnalyticalAnswer({ 
            answer: htmlReport, 
            question: "Network Analysis Report",
            isHtml: true 
          });
          setShowAnalyticalModal(true);
          
          // Auto-hide after 30 seconds for reports (longer since it's more detailed)
          setTimeout(() => {
            setShowAnalyticalModal(false);
            setAnalyticalAnswer(null);
          }, 30000);
        };


return (
    <div width="95%">
      <input
        type="text"
        placeholder="Show me all the MSEI students from CA"
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
      <button id="visualize" onClick={() => window.open("https://awuchen.github.io/greif-network-3d/", "_blank")}>Visualize3D</button>
      <button id="info" onClick={() => window.open("https://www.hako.soooul.xyz/drafts/washi", "_blank")}>Info</button>
      <button 
        id="timeline" 
        onClick={toggleTimelineMode}
      >
        {timelineMode ? 'Exit Timeline' : 'Timeline'}
      </button>
      
      {/* Timeline Controls */}
      {timelineMode && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'white',
          padding: '15px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 1000,
          minWidth: '400px',
          textAlign: 'center'
        }}>
          <h4 style={{ margin: '0 0 10px 0', color: '#333' }}>Network Timeline</h4>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <button
              onClick={() => {
                if (timelineDate) {
                  const newDate = new Date(timelineDate.getTime() - 60000); // -1 minute
                  updateTimelineDate(newDate);
                }
              }}
              style={{
                backgroundColor: '#2196F3',
                color: 'white',
                border: 'none',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px'
              }}
            >
              -1m
            </button>
            <input
              type="range"
              min={timelineStats?.earliest?.getTime() || Date.now() - 86400000} // Default to 24 hours ago if no earliest
              max={timelineStats?.latest?.getTime() || Date.now()}
              value={timelineDate?.getTime() || Date.now()}
              step={60000} // 1 minute steps (60,000 milliseconds)
              onChange={(e) => {
                const timestamp = parseInt(e.target.value);
                const date = new Date(timestamp);
                updateTimelineDate(date);
              }}
              style={{ flex: 1 }}
            />
            <button
              onClick={() => {
                if (timelineDate) {
                  const newDate = new Date(timelineDate.getTime() + 60000); // +1 minute
                  updateTimelineDate(newDate);
                }
              }}
              style={{
                backgroundColor: '#2196F3',
                color: 'white',
                border: 'none',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px'
              }}
            >
              +1m
            </button>
            <span style={{ fontSize: '12px', color: '#666', minWidth: '120px' }}>
              {timelineDate ? `${timelineDate.toLocaleDateString()} ${timelineDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}` : 'Current Time'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '10px' }}>
            <button
              onClick={() => {
                if (timelineDate) {
                  const newDate = new Date(timelineDate.getTime() - 300000); // -5 minutes
                  updateTimelineDate(newDate);
                }
              }}
              style={{
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px'
              }}
            >
              -5m
            </button>

            <button
              onClick={() => loadTimelineData(new Date())}
              style={{
                backgroundColor: '#9C27B0',
                color: 'white',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Load Current
            </button>
            <button
              onClick={() => {
                if (timelineDate) {
                  const newDate = new Date(timelineDate.getTime() + 300000); // +5 minutes
                  updateTimelineDate(newDate);
                }
              }}
              style={{
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '10px'
              }}
            >
              +5m
            </button>
          </div>
          {timelineData && (
            <div style={{ fontSize: '11px', color: '#666', display: 'flex', justifyContent: 'space-between' }}>
              <span>Nodes: {timelineData.nodes.length}</span>
              <span>Connections: {timelineData.links.length}</span>
              <span>Time: {timelineDate?.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
            </div>
          )}
          {timelineStats && (
            <div style={{ fontSize: '10px', color: '#999', marginTop: '8px', textAlign: 'center' }}>
              Timeline: {timelineStats.earliest?.toLocaleDateString()} {timelineStats.earliest?.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} 
              to {timelineStats.latest?.toLocaleDateString()} {timelineStats.latest?.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </div>
          )}
        </div>
      )}
      
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
          style={{ 
            position: "absolute", 
            top: "50%", 
            left: "50%", 
            transform: "translate(-50%, -50%)", 
            width: "80%", 
            maxWidth: "800px",
            maxHeight: "80vh",
            backgroundColor: "white", 
            border: "2px solid #3498db", 
            borderRadius: "10px",
            boxShadow: "0px 0px 20px rgba(0, 0, 0, 0.3)", 
            zIndex: 1000,
            overflow: "hidden"
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{
            padding: "15px 20px",
            backgroundColor: "#3498db",
            color: "white",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}>
            <h3 style={{ margin: 0, fontSize: "18px" }}>{analyticalAnswer.question}</h3>
            <button 
              onClick={() => {
                setShowAnalyticalModal(false);
                setAnalyticalAnswer(null);
              }}
              style={{
                background: "none",
                border: "none",
                color: "white",
                fontSize: "20px",
                cursor: "pointer",
                padding: "0",
                width: "30px",
                height: "30px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              ×
            </button>
          </div>
          <div style={{ padding: "0", maxHeight: "calc(80vh - 60px)", overflow: "hidden" }}>
            {analyticalAnswer.isHtml ? (
              <div dangerouslySetInnerHTML={{ __html: analyticalAnswer.answer }} />
            ) : (
              <div style={{ padding: "20px", maxHeight: "calc(80vh - 60px)", overflowY: "auto" }}>
          <p><strong>Answer:</strong> {analyticalAnswer.answer}</p>
              </div>
            )}
          </div>
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
  graphData={timelineMode && timelineData ? timelineData : data}
  nodeId="name"
  nodeLabel={(node) => node.role || "No Program Specified"}
  linkLabel={(link) => {
    if (hoveredLink && hoveredLink.link === link) {
      return hoveredLink.note || "No note added";
    }
    return null;
  }}

  onNodeClick={handleNodeClick}
  onNodeHover={handleNodeHover}
  onLinkClick={handleLinkClick}
  onLinkHover={handleLinkHover}

  onBackgroundClick={() => {
    setFocusNode(null);
    setClickedNode(null);
    setLastAction(null);
    setMutatedNodes([]);
    setSelectedNode(null);
    setShowAnalyticalModal(false);
    setAnalyticalAnswer(null);
    setSelectedLink(null);
    setRelationshipData({});
    
    // Clear any active focus timeouts when background is clicked
    // Note: focusTimeout is managed in GraphView component, so we don't need to clear it here
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
    
    // Use latestNode for editing (black), pollingFocusNode for viewing (green), clickedNode for selection (gray), or white for normal
    // Visual states persist even after focus period ends
    let fillColor = "white";
    if (node.name === latestNode) {
      fillColor = "black"; // Editable node - persists after focus
    } else if (node.name === pollingFocusNode) {
      fillColor = "green"; // Non-editable polling focus - persists after focus
    } else if (node.name === clickedNode) {
      fillColor = "gray"; // Clicked node - persists after focus
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
    
    // Extract first name from full name
    const firstName = node.name.split(' ')[0];
    ctx.fillText(firstName, node.x + 10, node.y);

    ctx.globalAlpha = 1.0; // Reset alpha for next node
  }}
  linkColor={(link) => {
    const sourceName = typeof link.source === 'object' ? link.source.name : link.source;
    const targetName = typeof link.target === 'object' ? link.target.name : link.target;
    const isConnected = visibilityNodes.has(sourceName) && visibilityNodes.has(targetName);
    
    // Check if this link is being hovered
    const isHovered = hoveredLink && hoveredLink.link === link;
    
    if (isHovered) {
      return '#000'; // Black when hovered
    }
    
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

  {/* NFC Name Input Popup */}
  {showNfcNamePopup && (
    <div 
      style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000, minWidth: "300px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3>Enter Info</h3>
      <p><strong>Name:</strong>
      <input 
        value={nfcNameInput} 
        onChange={(e) => setNfcNameInput(e.target.value)}
        placeholder="Enter your name" 
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            handleNfcNameSubmit();
          }
        }}
      /></p>

      <p><strong>Program:</strong>
      <input 
        value={nfcRoleInput} 
        onChange={(e) => setNfcRoleInput(e.target.value)}
        placeholder="e.g., MSEI, MSSE, MSBA, MBA, etc." 
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            handleNfcNameSubmit();
          }
        }}
      /></p>

      <p><button onClick={handleNfcNameSubmit} style={{ marginRight: "10px", padding: "8px 16px" }}>Continue</button>
      <button onClick={() => {
        setShowNfcNamePopup(false);
        setNfcNameInput("");
        setNfcRoleInput("");
      }} style={{ padding: "8px 16px" }}>Cancel</button></p>
    </div>
  )}

  {/* Profile Completion Popup (for new nodes) */}
  {showProfilePopup && selectedNode && editedNode && (
    <div 
      style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000, minWidth: "300px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3>Complete Your Profile</h3>
      <p><strong>Name:</strong>
      <input 
      name="name" 
      value={editedNode.name} 
        placeholder="Enter your name" 
      onChange={handleEditChange}
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
      /></p>

      <p><strong>Program:</strong>
      <input 
        name="role" 
        value={editedNode.role || ""} 
        placeholder="e.g., MSEI, MBA, BS, MS, PhD" 
        onChange={handleEditChange}
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
      /></p>

      <p><strong>Location:</strong>
      <input 
        name="location" 
        value={editedNode.location || ""} 
        placeholder="e.g., Los Angeles, CA" 
        onChange={handleEditChange}
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
      /></p>

      <p><strong>Email/Website:</strong>
      <input 
        name="website" 
        value={editedNode.website || ""} 
        placeholder="your.email@example.com" 
        onChange={handleEditChange}
        style={{ width: "100%", marginTop: "5px", padding: "5px" }}
      /></p>

      <p><button onClick={saveNewProfileFromNfc} style={{ marginRight: "10px", padding: "8px 16px" }}>Save Profile</button>
      <button onClick={() => setShowProfilePopup(false)} style={{ padding: "8px 16px" }}>Cancel</button></p>
    </div>
  )}

  {/* Regular Node Info Popup (for clicking on any node) */}
  {selectedNode && !showProfilePopup && !showNfcNamePopup && !showNfcRelationshipPopup && (
    <div 
      style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000, minWidth: "300px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3>Network Info</h3>
      <p><strong>Name:</strong> {selectedNode?.name}</p>
      {selectedNode?.role && <p><strong>Program:</strong> {selectedNode.role}</p>}
      {selectedNode?.location && <p><strong>Location:</strong> {selectedNode.location}</p>}
      {selectedNode?.website && <p><strong>Email:</strong>{" "}
        <a href={`mailto:${selectedNode.website}`}>
        {selectedNode.website.length > 30 
          ? `${selectedNode.website.substring(0, 30)}...`
        : selectedNode.website}
        </a>
      </p>}
      

    </div>
  )}

  {/* NFC Relationship Note Popup (only during NFC flow) */}
  {showNfcRelationshipPopup && selectedNode && (
    <div 
      style={{ position: "absolute", top: "20%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000, minWidth: "300px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3>Add Connection Note</h3>
      <p><strong>Connected to:</strong> {selectedNode?.name}</p>
      {selectedNode?.role && <p><strong>Program:</strong> {selectedNode.role}</p>}
      {selectedNode?.location && <p><strong>Location:</strong> {selectedNode.location}</p>}
      {selectedNode?.website && <p><strong>Email:</strong>{" "}
        <a href={`mailto:${selectedNode.website}`}>
          {selectedNode.website.length > 30 
            ? `${selectedNode.website.substring(0, 30)}...`
          : selectedNode.website}
        </a>
      </p>}
      
      <p><strong>Note:</strong>
      <textarea 
        value={relationshipNote} 
        onChange={(e) => setRelationshipNote(e.target.value)}
        placeholder="e.g., Met at USC networking event, Introduced by mutual friend, Worked together on project..."
        style={{ width: "100%", marginTop: "5px", padding: "5px", minHeight: "80px", resize: "vertical" }}
      /></p>

      <p><button onClick={saveRelationshipNote} style={{ padding: "8px 16px" }}>Save</button></p>
    </div>
  )}

  {/* Relationship Note Popup */}
  {selectedLink && relationshipData && (
    <div 
      style={{ position: "absolute", top: "30%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px", backgroundColor: "white", border: "1px solid black", boxShadow: "0px 0px 10px rgba(0, 0, 0, 0.3)", zIndex: 1000, minWidth: "300px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3>Connection Details</h3>
      <p><strong>From:</strong> {relationshipData.sourceName}</p>
      <p><strong>To:</strong> {relationshipData.targetName}</p>
      
      {relationshipData.note ? (
        <>
          <p><strong>Note:</strong></p>
          <div style={{ 
            backgroundColor: "#f5f5f5", 
            padding: "10px", 
            borderRadius: "4px", 
            marginTop: "5px",
            fontStyle: "italic"
          }}>
            "{relationshipData.note}"
          </div>
        </>
      ) : (
        <p style={{ color: "#666", fontStyle: "italic" }}>No note added yet.</p>
      )}
      

    </div>
  )}



  </div>
  );
    };

    export default CypherViz;

