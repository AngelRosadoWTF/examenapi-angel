// src/app.js
const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const purchasesRouter = require('./routes/purchases');

const app = express();
app.use(bodyParser.json());

app.use('/api/purchases', purchasesRouter);

app.get('/', (req, res) => res.send('Purchases API OK'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
