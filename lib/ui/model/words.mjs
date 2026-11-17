// Words the tab models share: a count with its noun, and the capital a card starts a sentence with.

// "1 reply", "3 replies".
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The model's words start lower case, as the terminal writes them; a card starts them with a capital.
export const sentence = (words) => words.charAt(0).toUpperCase() + words.slice(1);
