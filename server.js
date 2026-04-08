const express = require('express');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.get('/', (req, res) => {
  res.status(200).send('KandiByKelton PLUR app is live');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
