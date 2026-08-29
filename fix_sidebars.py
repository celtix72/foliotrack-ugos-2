import os
import re

files = [
    "private_views/portfolio_detail.html",
    "private_views/admin.html",
    "private_views/notifications.html",
    "private_views/asset_management.html",
    "private_views/dividend.html",
    "private_views/history.html",
    "private_views/market_overview.html",
    "private_views/settings.html",
    "private_views/reports.html"
]

dashboard_footer = """        <div class="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div class="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Portfolios</div>
            <div class="space-y-1" id="sidebar-portfolios">
                <div class="px-3 py-2 text-xs text-slate-400 italic">Loading...</div>
            </div>
        </div>
    </nav>
    <div class="p-4 border-t border-slate-200 dark:border-slate-800">
        <div class="flex items-center gap-3 p-2 rounded-xl bg-slate-100 dark:bg-slate-900">
            <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400 font-bold text-xs" id="sidebar-user-initials">UN</div>
            <div class="flex-1 overflow-hidden">
                <p class="text-sm font-bold truncate" id="sidebar-user-name">User</p>
                <p class="text-xs text-slate-500 truncate" id="sidebar-user-role">Utente</p>
            </div>
            <span class="material-symbols-outlined text-slate-400 text-sm cursor-pointer hover:text-rose-500 transition-colors" id="sidebar-logout-btn">logout</span>
        </div>
    </div>
</aside>"""

pattern = re.compile(r'<div class="pt-4 border-t border-slate-200 dark:border-slate-800">\s*<div class="space-y-1" id="sidebar-portfolios">.*?<\/aside>', re.DOTALL)
pattern_with_label = re.compile(r'<div class="pt-4 border-t border-slate-200 dark:border-slate-800">\s*<div class="px-3 py-2 text-\[10px\] font-bold text-slate-400 uppercase tracking-widest">Portfolios<\/div>\s*<div class="space-y-1" id="sidebar-portfolios">.*?<\/aside>', re.DOTALL)

for f in files:
    if not os.path.exists(f): continue
    with open(f, 'r') as file:
        content = file.read()
    
    # Check which pattern matches
    if pattern_with_label.search(content):
        # Already has the label, but might have the old user-role format, let's replace anyway
        new_content = pattern_with_label.sub(dashboard_footer, content)
    else:
        new_content = pattern.sub(dashboard_footer, content)
        
    with open(f, 'w') as file:
        file.write(new_content)
    print(f"Fixed {f}")

