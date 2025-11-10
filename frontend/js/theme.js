// Dynamic Mood Theme
const themes = {
    happy: { background: '#ffeb3b', color: '#000' },
    calm: { background: '#2196f3', color: '#fff' },
    energetic: { background: '#f44336', color: '#fff' },
};

function applyTheme(mood) {
    const theme = themes[mood] || themes['calm'];
    document.body.style.backgroundColor = theme.background;
    document.body.style.color = theme.color;
}

// Example usage
applyTheme('happy');