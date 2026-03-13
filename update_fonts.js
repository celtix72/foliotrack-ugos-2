const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

files.forEach(file => {
    const filePath = path.join(publicDir, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    // 1. Remove Inter font link
    content = content.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^>]+>/g, '');

    // 2. Change Tailwind display font to use var
    content = content.replace(/"display":\s*\["Inter",\s*"sans-serif"\]/g, '"display": ["var(--app-font-family, \'JetBrains Mono\')", "monospace"]');

    // 3. Remove body font-family override
    content = content.replace(/\s*body\s*\{\s*font-family:\s*'Inter',\s*sans-serif;\s*\}/g, '');

    // 4. Also remove the font-family inline if it exists in body tag classes (it usually doesn't, but just in case)
    // Wait, let's inject <script src="/theme.js"></script> before </head>
    if (!content.includes('<script src="/theme.js"></script>')) {
        content = content.replace('</head>', '    <script src="/theme.js"></script>\n</head>');
    }
    
    // Additional generic cleanup to avoid double newlines
    content = content.replace(/\n\s*\n\s*<script id="tailwind-config/g, '\n<script id="tailwind-config');

    fs.writeFileSync(filePath, content);
    console.log(`Updated ${file}`);
});
