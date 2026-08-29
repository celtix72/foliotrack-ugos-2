import re
with open('src/server.js', 'r') as f:
    content = f.read()

helper_code = """
// Helper per iniettare la sidebar nelle viste desktop
function serveWithSidebar(req, res, file) {
    const isMobileView = file.includes('_mobile.html');
    const viewPath = path.join(__dirname, '../private_views', file);
    
    if (isMobileView) {
        return res.sendFile(viewPath);
    }
    
    const fs = require('fs');
    const sidebarPath = path.join(__dirname, '../private_views/partials', 'sidebar_partial.html');
    
    fs.readFile(viewPath, 'utf8', (err, viewData) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error loading view');
        }
        fs.readFile(sidebarPath, 'utf8', (err, sidebarData) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error loading sidebar partial');
            }
            const finalHtml = viewData.replace(/<aside\s+id="app-sidebar"[^>]*>[\s\S]*?<\/aside>/, sidebarData);
            res.send(finalHtml);
        });
    });
}

// Protected app pages
"""

content = content.replace("// Protected app pages\n", helper_code)

# Replace all res.sendFile(path.join(__dirname, '../private_views', file));
# with serveWithSidebar(req, res, file);
# BUT only for the protected routes that define `file`.
content = re.sub(r'res\.sendFile\(path\.join\(__dirname,\s*\'\.\./private_views\',\s*file\)\);', r'serveWithSidebar(req, res, file);', content)

with open('src/server.js', 'w') as f:
    f.write(content)
