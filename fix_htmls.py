import os
import re

files = [
    "private_views/portfolio_detail.html",
    "private_views/admin.html",
    "private_views/notifications.html",
    "private_views/asset_management.html",
    "private_views/dashboard.html",
    "private_views/dividend.html",
    "private_views/history.html",
    "private_views/market_overview.html",
    "private_views/settings.html",
    "private_views/reports.html"
]

pattern = re.compile(r'<aside class="w-72 border-r border-slate-200 dark:border-slate-800 flex flex-col h-screen sticky top-0 bg-white dark:bg-surface-dark shrink-0">.*?<\/aside>', re.DOTALL)

for f in files:
    if not os.path.exists(f): continue
    with open(f, 'r') as file:
        content = file.read()
    
    new_content = pattern.sub('<aside id="app-sidebar"></aside>', content)
        
    with open(f, 'w') as file:
        file.write(new_content)
    print(f"Fixed {f}")

