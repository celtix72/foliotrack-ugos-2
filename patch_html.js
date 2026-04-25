const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

for (const file of files) {
    const filePath = path.join(publicDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    // 1. Sidebar Initials
    const sidebarInitialsRegex = /<div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400 font-bold text-xs">(\s*)UN(\s*)<\/div>/g;
    if (sidebarInitialsRegex.test(content)) {
        content = content.replace(sidebarInitialsRegex, '<div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400 font-bold text-xs" id="sidebar-user-initials">$1UN$2</div>');
        changed = true;
    }

    // 2. Sidebar User Name
    const sidebarNameRegex = /<p class="text-sm font-bold truncate">User<\/p>/g;
    if (sidebarNameRegex.test(content)) {
        content = content.replace(sidebarNameRegex, '<p class="text-sm font-bold truncate" id="sidebar-user-name">User</p>');
        changed = true;
    }

    // 3. Sidebar Logout
    const sidebarLogoutRegex = /<span class="material-symbols-outlined text-slate-400 text-sm cursor-pointer">logout<\/span>/g;
    if (sidebarLogoutRegex.test(content)) {
        content = content.replace(sidebarLogoutRegex, '<span class="material-symbols-outlined text-slate-400 text-sm cursor-pointer" id="sidebar-logout-btn">logout</span>');
        changed = true;
    }

    // 4. Header User Name
    const headerNameRegex = /<p class="text-xs font-bold">User<\/p>/g;
    if (headerNameRegex.test(content)) {
        content = content.replace(headerNameRegex, '<p class="text-xs font-bold" id="header-user-name">User</p>');
        changed = true;
    }

    // 5. Header Role
    const headerRoleRegex = /<p class="text-\[9px\] text-slate-500 font-bold uppercase tracking-tighter">M2T<\/p>/g;
    if (headerRoleRegex.test(content)) {
        content = content.replace(headerRoleRegex, '<p class="text-[9px] text-slate-500 font-bold uppercase tracking-tighter" id="header-user-role">M2T</p>');
        changed = true;
    }

    // 6. Sidebar role/admin link. Let's add it next to the app-version-label.
    // Wait, let's just make sure we add the admin link if it's missing, but it's simpler to just replace the ones that are there.
    
    if (changed) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('Patched', file);
    }
}
