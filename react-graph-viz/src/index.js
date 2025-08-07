import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import * as serviceWorker from './serviceWorker';
import * as neo4j from  'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI || 'neo4j+s://7714be1a.databases.neo4j.io',
  neo4j.auth.basic(
    process.env.NEO4J_USER || 'neo4j',
    process.env.NEO4J_PASSWORD || 'lwW-hWpruNTNNrD-gCAMreXMZcUlAFcrjxmaeL94ZzM'
  ),
  {
    //encrypted: process.env.NEO4J_ENCRYPTED ? 'ENCRYPTION_ON' : 'ENCRYPTION_OFF',
    //encrypted: process.env.NEO4J_ENCRYPTED = 'ENCRYPTION_ON',
  }
)

ReactDOM.render(
  <React.StrictMode>
    <App driver={driver}/>
  </React.StrictMode>,
  document.getElementById('root')
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
