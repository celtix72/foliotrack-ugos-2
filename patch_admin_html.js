const fs = require('fs');
let code = fs.readFileSync('private_views/admin.html', 'utf8');

const oldDropdown = `                            <select id="ai-engine" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-indigo-500 outline-none">
                                <option value="Gemini">Gemini</option>
                                <option value="Qwen">Qwen</option>
                                <option value="OpenAI">OpenAI</option>
                                <option value="Agnes">Agnes AI</option>
                                <option value="Both">Confronto (Gemini + Qwen)</option>
                            </select>`;

const newDropdown = `                            <select id="ai-engine" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-indigo-500 outline-none">
                                <option value="Gemini_Free">Gemini (Free)</option>
                                <option value="Gemini_Pay">Gemini (Pay)</option>
                                <option value="Qwen_Free">Qwen (Free)</option>
                                <option value="Qwen_Pay">Qwen (Pay)</option>
                                <option value="OpenAI_Free">OpenAI (Free)</option>
                                <option value="OpenAI_Pay">OpenAI (Pay)</option>
                                <option value="Agnes_Free">Agnes AI (Free)</option>
                                <option value="Agnes_Pay">Agnes AI (Pay)</option>
                                <option value="Both">Confronto (Gemini + Qwen)</option>
                            </select>`;

code = code.replace(oldDropdown, newDropdown);

const oldKeys = `                        <!-- API Keys -->
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div>
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Gemini API Key</label>
                                <input type="password" id="ai-gemini-key" placeholder="AIzaSy..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                            </div>
                            <div>
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Qwen API Key</label>
                                <input type="password" id="ai-qwen-key" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                            </div>
                            <div>
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">OpenAI API Key</label>
                                <input type="password" id="ai-openai-key" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                            </div>
                            <div>
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Agnes API Key</label>
                                <input type="password" id="ai-agnes-key" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                            </div>
                        </div>`;

const newKeys = `                        <!-- API Keys -->
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <!-- Gemini -->
                            <div class="p-3 border border-slate-200 dark:border-slate-800 rounded-lg space-y-3">
                                <h4 class="text-xs font-black text-slate-700 dark:text-slate-300">Gemini</h4>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Free)</label>
                                    <input type="password" id="ai-gemini-key-free" placeholder="AIzaSy..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Pay)</label>
                                    <input type="password" id="ai-gemini-key-pay" placeholder="AIzaSy..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                            </div>
                            <!-- Qwen -->
                            <div class="p-3 border border-slate-200 dark:border-slate-800 rounded-lg space-y-3">
                                <h4 class="text-xs font-black text-slate-700 dark:text-slate-300">Qwen</h4>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Free)</label>
                                    <input type="password" id="ai-qwen-key-free" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Pay)</label>
                                    <input type="password" id="ai-qwen-key-pay" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                            </div>
                            <!-- OpenAI -->
                            <div class="p-3 border border-slate-200 dark:border-slate-800 rounded-lg space-y-3">
                                <h4 class="text-xs font-black text-slate-700 dark:text-slate-300">OpenAI</h4>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Free)</label>
                                    <input type="password" id="ai-openai-key-free" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Pay)</label>
                                    <input type="password" id="ai-openai-key-pay" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                            </div>
                            <!-- Agnes -->
                            <div class="p-3 border border-slate-200 dark:border-slate-800 rounded-lg space-y-3">
                                <h4 class="text-xs font-black text-slate-700 dark:text-slate-300">Agnes</h4>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Free)</label>
                                    <input type="password" id="ai-agnes-key-free" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                                <div>
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">API Key (Pay)</label>
                                    <input type="password" id="ai-agnes-key-pay" placeholder="sk-..." class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500">
                                </div>
                            </div>
                        </div>`;

code = code.replace(oldKeys, newKeys);

const oldLoad = `                if (settings) {
                    document.getElementById('ai-engine').value = settings.aiEngine || 'Gemini';
                    document.getElementById('ai-gemini-key').value = settings.geminiApiKey || '';
                    document.getElementById('ai-qwen-key').value = settings.qwenApiKey || '';
                    document.getElementById('ai-openai-key').value = settings.openaiApiKey || '';
                    document.getElementById('ai-agnes-key').value = settings.agnesApiKey || '';`;

const newLoad = `                if (settings) {
                    document.getElementById('ai-engine').value = settings.aiEngine || 'Gemini_Free';
                    document.getElementById('ai-gemini-key-free').value = settings.geminiApiKeyFree || '';
                    document.getElementById('ai-gemini-key-pay').value = settings.geminiApiKeyPay || '';
                    document.getElementById('ai-qwen-key-free').value = settings.qwenApiKeyFree || '';
                    document.getElementById('ai-qwen-key-pay').value = settings.qwenApiKeyPay || '';
                    document.getElementById('ai-openai-key-free').value = settings.openaiApiKeyFree || '';
                    document.getElementById('ai-openai-key-pay').value = settings.openaiApiKeyPay || '';
                    document.getElementById('ai-agnes-key-free').value = settings.agnesApiKeyFree || '';
                    document.getElementById('ai-agnes-key-pay').value = settings.agnesApiKeyPay || '';`;

code = code.replace(oldLoad, newLoad);

const oldSave = `                const payload = {
                    aiEngine: document.getElementById('ai-engine').value,
                    geminiApiKey: document.getElementById('ai-gemini-key').value,
                    qwenApiKey: document.getElementById('ai-qwen-key').value,
                    openaiApiKey: document.getElementById('ai-openai-key').value,
                    agnesApiKey: document.getElementById('ai-agnes-key').value,`;

const newSave = `                const payload = {
                    aiEngine: document.getElementById('ai-engine').value,
                    geminiApiKeyFree: document.getElementById('ai-gemini-key-free').value,
                    geminiApiKeyPay: document.getElementById('ai-gemini-key-pay').value,
                    qwenApiKeyFree: document.getElementById('ai-qwen-key-free').value,
                    qwenApiKeyPay: document.getElementById('ai-qwen-key-pay').value,
                    openaiApiKeyFree: document.getElementById('ai-openai-key-free').value,
                    openaiApiKeyPay: document.getElementById('ai-openai-key-pay').value,
                    agnesApiKeyFree: document.getElementById('ai-agnes-key-free').value,
                    agnesApiKeyPay: document.getElementById('ai-agnes-key-pay').value,`;

code = code.replace(oldSave, newSave);

fs.writeFileSync('private_views/admin.html', code, 'utf8');
console.log('Patched admin.html');
