import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  HeartPulse, PackagePlus, Activity, AlertTriangle, Database, Download, CheckCircle,
  X, Search, Trash2, Camera, Calendar, Filter, ArrowDownUp, Lock, Unlock, Edit2, Clock,
  PieChart as PieChartIcon, BarChart3, Users, Shield, ClipboardList, RefreshCw, Upload, FileText, Sparkles
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { fetchAllData, callAction as rawCallAction } from './appsScriptClient';
import { parseDocumentFile, parseImageWithAi, detectKind, matchItem, matchItems, normalizeCode, suggestCode, availableBatches, isAutoAllocatable, planWriteoffRows } from './documentImport';

// Сервер відповідає цим текстом (Code.gs, authorize_), коли PIN поточної сесії більше не існує:
// адмін змінив PIN або видалив обліковий запис. Тоді сесію треба завершити, а не лишати
// користувача з "мертвими" кнопками, які щоразу дають помилку.
const INVALID_PIN_ERROR = 'Невірний PIN-код.';
let sessionInvalidHandler = null; // реєструє компонент App

const callAction = async (action, payload, pin) => {
  const result = await rawCallAction(action, payload, pin);
  // Для самого входу ('login') "Невірний PIN" — звичайна відповідь, а не втрата сесії.
  if (result && result.success === false && result.error === INVALID_PIN_ERROR && pin && action !== 'login' && sessionInvalidHandler) {
    sessionInvalidHandler();
  }
  return result;
};

const DEFAULT_SUBCATEGORIES = [
  { id: 'sc1', name: 'Клапани АК' },
  { id: 'sc2', name: 'Клапани МК' },
  { id: 'sc3', name: 'Кільця МК' },
  { id: 'sc4', name: 'Кільця ТК' },
  { id: 'sc5', name: 'Протези аорти' },
  { id: 'sc6', name: 'Оксигенатори' }
];

// Генерація ID на клієнті — використовується лише для тимчасових локальних елементів
// (наприклад "кошика" матеріалів у формі списання до моменту відправки на сервер).
// Персистентні ID для записів у таблицях тепер генерує Apps Script на сервері.
const genId = (prefix) => {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
};

// Довжина PIN: сервер (Code.gs) приймає 4–6 цифр, тому екран входу теж.
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 6;

// Безпечне приведення до рядка. Google Таблиці можуть віддати "текстове" поле числом
// (LOT 00123 → 123, цифровий код → число), а виклики на кшталт .toLowerCase() на числі
// кидають TypeError і валять увесь інтерфейс.
const str = (v) => (v === undefined || v === null) ? '' : String(v);

// Термін придатності тепер необов'язковий. new Date('') дає NaN, а порівняння з NaN ламає сортування,
// тому партії БЕЗ терміну завжди йдуть у кінець (dir = 1 — від найближчого терміну, -1 — від найдальшого).
const compareExpiry = (a, b, dir = 1) => {
  const emptyA = !a; const emptyB = !b;
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : (emptyA ? 1 : -1);
  const x = new Date(a).getTime(); const y = new Date(b).getTime();
  return x === y ? 0 : (x < y ? -dir : dir);
};
const fmtDateUk = (d) => (d ? new Date(d).toLocaleDateString('uk-UA') : '—');

// Приводить усі поля, які UI трактує як текст, до рядків одразу при завантаженні даних.
const normalizeData = (data) => ({
  materials: (data.materials || []).map(m => ({ ...m, name: str(m.name), code: str(m.code) })),
  stock: (data.stock || []).map(s => ({ ...s, lot_number: str(s.lot_number), serial_number: str(s.serial_number), size: str(s.size) })),
  operations: (data.operations || []).map(o => ({ ...o, operation_num: str(o.operation_num), patient_case_id: str(o.patient_case_id) })),
  expenses: data.expenses || [],
  subcategories: (data.subcategories || []).map(sc => ({ ...sc, name: str(sc.name) })),
  writeoffs: data.writeoffs || [],
  users: (data.users || []).map(u => ({ ...u, name: str(u.name), pin: str(u.pin) })),
  templates: (data.templates || []).map(t => ({ ...t, name: str(t.name) })),
  templateItems: data.templateItems || []
});

// Захист від "білого екрана": помилка рендеру всередині вкладки показує повідомлення
// замість того, щоб знести весь застосунок. При зміні resetKey (вкладки) стан скидається.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Помилка інтерфейсу:', error, info); }
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-xl mx-auto bg-slate-900 border border-rose-900/50 rounded-3xl p-8 text-center space-y-4">
        <AlertTriangle size={40} className="mx-auto text-rose-500" />
        <p className="font-bold text-white">Сталася помилка в інтерфейсі.</p>
        <p className="text-xs text-slate-400 break-words">{String((this.state.error && this.state.error.message) || this.state.error)}</p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => this.setState({ error: null })} className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-2.5 px-5 rounded-xl">Спробувати знову</button>
          <button onClick={() => window.location.reload()} className="bg-teal-600 hover:bg-teal-500 text-white font-bold py-2.5 px-5 rounded-xl">Перезавантажити</button>
        </div>
      </div>
    );
  }
}

// Підтвердження небезпечних дій (видалення) замість одного випадкового тапу.
// Використання: const [askConfirm, confirmDialog] = useConfirm();
//   if (!(await askConfirm({ title, message, confirmLabel }))) return;   ...   {confirmDialog}
const useConfirm = () => {
  const [request, setRequest] = useState(null);
  const askConfirm = useCallback((options) => new Promise((resolve) => setRequest({ ...options, resolve })), []);
  const answer = (result) => { if (request) request.resolve(result); setRequest(null); };
  const confirmDialog = request ? (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm z-[70] flex justify-center items-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-md shadow-2xl p-6 space-y-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-rose-500 shrink-0 mt-0.5" size={24} />
          <div>
            <h3 id="confirm-title" className="text-lg font-bold text-white">{request.title}</h3>
            {request.message && <p className="text-sm text-slate-400 mt-2 whitespace-pre-line">{request.message}</p>}
          </div>
        </div>
        <div className="flex gap-3">
          <button autoFocus onClick={() => answer(false)} className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 rounded-xl">Скасувати</button>
          <button onClick={() => answer(true)} className="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded-xl">{request.confirmLabel || 'Видалити'}</button>
        </div>
      </div>
    </div>
  ) : null;
  return [askConfirm, confirmDialog];
};

const Dashboard = ({ state, dispatch, sessionPin }) => {
  const [askConfirm, confirmDialog] = useConfirm();
  const [selectedOp, setSelectedOp] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const totalItems = state.stock.reduce((sum, item) => sum + item.quantity, 0);

  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const operationsLast30Days = state.operations.filter(op => new Date(op.operation_date) >= thirtyDaysAgo).length;

  const thirtyDaysFuture = new Date(); thirtyDaysFuture.setDate(thirtyDaysFuture.getDate() + 30);
  const expiringItems = state.stock.filter(item => new Date(item.expiration_date) <= thirtyDaysFuture && item.quantity > 0);
  const lowStockItems = state.materials.filter(mat => {
    const totalQty = state.stock.filter(s => s.material_id === mat.id).reduce((sum, s) => sum + s.quantity, 0);
    return totalQty < mat.min_stock;
  });

  const pieData = useMemo(() => {
    const categories = {};
    state.stock.forEach(batch => {
       if (batch.quantity <= 0) return;
       const mat = state.materials.find(m => m.id === batch.material_id);
       if (!mat) return;
       const cat = mat.subcategory || 'Без підкатегорії';
       categories[cat] = (categories[cat] || 0) + batch.quantity;
    });
    return Object.entries(categories).map(([name, value]) => ({ name, value })).filter(d => d.value > 0).sort((a,b)=>b.value - a.value);
  }, [state.stock, state.materials]);

  const COLORS = ['#0d9488', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b'];

  const barData = useMemo(() => {
    const months = {};
    state.operations.forEach(op => {
      const month = op.operation_date.substring(0, 7);
      months[month] = (months[month] || 0) + 1;
    });
    return Object.entries(months).map(([name, value]) => ({ name, value })).sort((a,b) => a.name.localeCompare(b.name)).slice(-6);
  }, [state.operations]);

  const handleDeleteOp = async () => {
    if (isDeleting) return;
    const linesCount = state.expenses.filter(e => e.operation_id === selectedOp.id).length;
    const confirmed = await askConfirm({
      title: `Видалити операцію ${selectedOp.operation_num}?`,
      message: `Запис про операцію зникне, а списані матеріали (${linesCount} поз.) повернуться на склад.\nДію буде записано в журнал.`,
      confirmLabel: 'Видалити операцію'
    });
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      const result = await callAction('deleteOperation', { operationId: selectedOp.id }, sessionPin);
      if (!result.success) { alert(result.error || "Помилка видалення операції."); return; }

      dispatch({ type: 'DELETE_OPERATION', payload: selectedOp.id });
      setSelectedOp(null);
    } catch (e) {
      console.error(e);
      alert("Помилка видалення операції: немає з'єднання з сервером.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 p-5 rounded-3xl shadow-lg relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-10"><Database size={64}/></div>
          <div className="flex items-center gap-3 text-slate-400 mb-2 relative z-10"><Database className="text-teal-400" size={18} /><h3 className="font-semibold text-xs uppercase tracking-widest">Загальний залишок</h3></div>
          <div className="text-3xl font-black text-white relative z-10 tracking-tight">{totalItems} <span className="text-lg text-slate-500 font-medium">шт</span></div>
          <p className="text-xs text-slate-400 mt-2 relative z-10"><span className="text-teal-400 font-bold">{operationsLast30Days}</span> операцій за останні 30 днів</p>
        </div>
        <div className={`border p-5 rounded-3xl shadow-lg relative overflow-hidden ${expiringItems.length > 0 ? 'bg-gradient-to-br from-rose-950 to-slate-900 border-rose-900/50' : 'bg-gradient-to-br from-slate-800 to-slate-900 border-slate-700'}`}>
          <div className="absolute top-0 right-0 p-4 opacity-10"><Calendar size={64} className={expiringItems.length > 0 ? 'text-rose-500' : 'text-slate-500'}/></div>
          <div className="flex items-center gap-3 text-slate-400 mb-2 relative z-10"><Calendar className={expiringItems.length > 0 ? 'text-rose-400' : 'text-slate-400'} size={18} /><h3 className="font-semibold text-xs uppercase tracking-widest text-slate-300">FEFO Контроль</h3></div>
          <div className={`text-3xl font-black tracking-tight relative z-10 ${expiringItems.length > 0 ? 'text-rose-400' : 'text-white'}`}>{expiringItems.length} <span className="text-sm text-slate-400 font-medium tracking-normal">партіям &lt; 30 днів</span></div>
        </div>
        <div className={`border p-5 rounded-3xl shadow-lg relative overflow-hidden ${lowStockItems.length > 0 ? 'bg-gradient-to-br from-amber-950 to-slate-900 border-amber-900/50' : 'bg-gradient-to-br from-slate-800 to-slate-900 border-slate-700'}`}>
          <div className="absolute top-0 right-0 p-4 opacity-10"><AlertTriangle size={64} className={lowStockItems.length > 0 ? 'text-amber-500' : 'text-slate-500'}/></div>
          <div className="flex items-center gap-3 text-slate-400 mb-2 relative z-10"><AlertTriangle className={lowStockItems.length > 0 ? 'text-amber-400' : 'text-slate-400'} size={18} /><h3 className="font-semibold text-xs uppercase tracking-widest text-slate-300">Дефіцит</h3></div>
          <div className={`text-3xl font-black tracking-tight relative z-10 ${lowStockItems.length > 0 ? 'text-amber-400' : 'text-white'}`}>{lowStockItems.length} <span className="text-sm text-slate-400 font-medium tracking-normal">позицій &lt; норми</span></div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
         <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2"><PieChartIcon className="text-teal-500" size={18}/> Розподіл залишків (шт)</h3>
            <div className="h-64">
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                      {pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(value) => value + ' шт'} contentStyle={{backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff'}} itemStyle={{color: '#fff'}}/>
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : <div className="h-full flex items-center justify-center text-slate-600">Склад порожній</div>}
            </div>
         </div>
         <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2"><BarChart3 className="text-teal-500" size={18}/> Динаміка операцій (останні 6 міс)</h3>
            <div className="h-64">
              {barData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip cursor={{fill: '#1e293b'}} formatter={(value) => value + ' опер.'} contentStyle={{backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff'}}/>
                    <Bar dataKey="value" fill="#0d9488" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="h-full flex items-center justify-center text-slate-600">Немає проведених операцій</div>}
            </div>
         </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl">
        <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2"><Activity size={20} className="text-teal-500" /> Останні проведені операції</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left"><thead className="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-950"><tr><th className="px-4 py-3 rounded-tl-xl">Дата</th><th className="px-4 py-3">№ Опер.</th><th className="px-4 py-3">Пацієнт (ІБ)</th><th className="px-4 py-3 rounded-tr-xl">Тип</th></tr></thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {state.operations.slice().sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5).map(op => (
                <tr key={op.id} onClick={() => setSelectedOp(op)} className="hover:bg-slate-800/50 transition-colors cursor-pointer group">
                  <td className="px-4 py-4 whitespace-nowrap">{fmtDateUk(op.operation_date)}</td>
                  <td className="px-4 py-4 font-mono text-teal-400 font-bold group-hover:text-teal-300">{op.operation_num}</td>
                  <td className="px-4 py-4 font-medium">{op.patient_case_id || '—'}</td>
                  <td className="px-4 py-4 text-slate-400">{op.operation_type || '—'}</td>
                </tr>
              ))}
              {state.operations.length === 0 && <tr><td colSpan="4" className="px-4 py-12 text-center text-slate-500">Історія операцій порожня</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {selectedOp && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex justify-center items-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
             <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-slate-950">
                <h3 className="text-lg font-bold text-white flex items-center gap-2"><Activity className="text-teal-500"/> Деталі операції {selectedOp.operation_num}</h3>
                <button onClick={()=>setSelectedOp(null)} className="text-slate-400 hover:text-white bg-slate-800 p-2 rounded-full"><X size={18}/></button>
             </div>
             <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                   <div><p className="text-slate-500 text-xs uppercase tracking-widest mb-1">Дата</p><p className="font-bold text-white">{fmtDateUk(selectedOp.operation_date)}</p></div>
                   <div><p className="text-slate-500 text-xs uppercase tracking-widest mb-1">ІБ Пацієнта</p><p className="font-bold text-white">{selectedOp.patient_case_id || '—'}</p></div>
                   <div className="col-span-2"><p className="text-slate-500 text-xs uppercase tracking-widest mb-1">Тип втручання</p><p className="font-bold text-white">{selectedOp.operation_type || '—'}</p></div>
                </div>
                <div className="mt-4 pt-4 border-t border-slate-800">
                   <p className="text-slate-500 text-xs uppercase tracking-widest mb-3 font-bold">Списані матеріали</p>
                   <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                      {state.expenses.filter(e => e.operation_id === selectedOp.id).map(exp => {
                         const batch = state.stock.find(s => s.id === exp.stock_batch_id) || state.writeoffs.find(w=>w.id === exp.stock_batch_id);
                         const mat = state.materials.find(m => m.id === batch?.material_id);
                         return (
                           <div key={exp.id} className="flex justify-between items-center bg-slate-950 p-3 rounded-xl border border-slate-800">
                             <div>
                               <p className="text-sm font-bold text-white">{mat?.name || 'Невідомий матеріал'}</p>
                               <div className="flex gap-2 items-center mt-1">
                                  {batch?.size && <span className="text-[10px] bg-teal-900/30 text-teal-400 px-1.5 rounded font-bold">Р: {batch.size}</span>}
                                  <span className="text-[10px] text-slate-400 font-mono">LOT: {batch?.lot_number || '-'}</span>
                               </div>
                             </div>
                             <div className="font-black text-teal-400">{exp.quantity} шт</div>
                           </div>
                         )
                      })}
                   </div>
                </div>
             </div>
             <div className="p-5 border-t border-slate-800 bg-slate-950/50 flex gap-3">
                <button onClick={handleDeleteOp} disabled={isDeleting} className="flex-1 bg-rose-950 text-rose-400 hover:bg-rose-900 hover:text-white py-3 rounded-xl font-bold flex justify-center items-center gap-2 transition-colors border border-rose-900/50 disabled:opacity-50 disabled:cursor-not-allowed"><Trash2 size={18}/> {isDeleting ? 'Видалення...' : 'Скасувати та видалити'}</button>
             </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
};

const SearchableDropdown = ({ state, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredBatches = useMemo(() => {
    if (!searchTerm) return [];
    let results = [];
    state.stock.forEach(batch => {
      if (batch.quantity <= 0) return;
      const mat = state.materials.find(m => m.id === batch.material_id);
      if (!mat) return;
      const searchStr = `${mat.name} ${mat.code} ${batch.lot_number} ${batch.serial_number || ''} ${batch.size || ''}`.toLowerCase();
      if (searchStr.includes(searchTerm.toLowerCase())) {
        results.push({ batch, mat });
      }
    });
    return results.slice(0, 10);
  }, [searchTerm, state]);

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
        <input
          type="text" value={searchTerm} onChange={(e) => {setSearchTerm(e.target.value); setIsOpen(true);}}
          onFocus={() => setIsOpen(true)}
          placeholder="Пошук зі складу (Назва, LOT, Розмір)..."
          className="w-full bg-slate-900 border border-slate-700 rounded-xl py-3 pl-10 pr-4 text-white focus:ring-2 focus:ring-teal-500 outline-none placeholder:text-slate-600"
        />
      </div>
      {isOpen && searchTerm && (
        <div className="absolute z-50 w-full mt-2 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden max-h-60 overflow-y-auto">
          {filteredBatches.length > 0 ? filteredBatches.map(({batch, mat}) => (
            <div key={batch.id} onClick={() => { onSelect(batch, mat); setSearchTerm(''); setIsOpen(false); }} className="p-3 hover:bg-slate-700 cursor-pointer border-b border-slate-700/50 last:border-0 flex justify-between items-center group">
              <div>
                <p className="text-sm font-bold text-white group-hover:text-teal-300 transition-colors">{mat.name} {batch.size && <span className="ml-1 text-teal-400 text-xs">Розмір: {batch.size}</span>}</p>
                <p className="text-[10px] text-slate-400 font-mono mt-0.5">LOT: {batch.lot_number || '—'} {batch.serial_number ? `| SN: ${batch.serial_number}` : ''}</p>
              </div>
              <div className="text-xs font-black bg-slate-900 px-2 py-1 rounded text-teal-400">{batch.quantity} шт</div>
            </div>
          )) : <div className="p-4 text-center text-sm text-slate-500">Нічого не знайдено на залишках</div>}
        </div>
      )}
    </div>
  );
};

const TemplateManagerModal = ({ state, dispatch, sessionPin, onClose }) => {
  const [askConfirm, confirmDialog] = useConfirm();
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState('');
  const [operationType, setOperationType] = useState('CABG On-pump');
  const [items, setItems] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(null);
  const [materialSearch, setMaterialSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (searchRef.current && !searchRef.current.contains(event.target)) setShowSuggestions(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const materialSuggestions = useMemo(() => {
    if (!materialSearch) return [];
    const q = materialSearch.toLowerCase();
    return state.materials.filter(m => str(m.name).toLowerCase().includes(q) || str(m.code).toLowerCase().includes(q)).slice(0, 8);
  }, [materialSearch, state.materials]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setOperationType('CABG On-pump');
    setItems([]);
  };

  const startEdit = (tpl) => {
    setEditingId(tpl.id);
    setName(tpl.name);
    setOperationType(tpl.operation_type || 'CABG On-pump');
    const tplItems = state.templateItems
      .filter(ti => ti.template_id === tpl.id)
      .map(ti => {
        const mat = state.materials.find(m => m.id === ti.material_id);
        return { material_id: ti.material_id, name: mat ? mat.name : '(матеріал видалено з довідника)', quantity: ti.quantity };
      });
    setItems(tplItems);
  };

  const addMaterial = (mat) => {
    setItems(prev => {
      const existing = prev.find(i => i.material_id === mat.id);
      if (existing) return prev.map(i => i.material_id === mat.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { material_id: mat.id, name: mat.name, quantity: 1 }];
    });
    setMaterialSearch('');
    setShowSuggestions(false);
  };

  const handleSave = async () => {
    if (!name.trim()) { alert('Введіть назву шаблону.'); return; }
    if (items.length === 0) { alert('Додайте хоча б один матеріал.'); return; }
    if (isSaving) return;

    setIsSaving(true);
    try {
      const payload = {
        id: editingId || '',
        name: name.trim(),
        operation_type: operationType,
        items: items.map(i => ({ material_id: i.material_id, quantity: i.quantity }))
      };
      const result = await callAction('saveTemplate', payload, sessionPin);
      if (!result.success) { alert(result.error || 'Помилка збереження шаблону.'); return; }
      dispatch({ type: editingId ? 'UPDATE_TEMPLATE' : 'ADD_TEMPLATE', payload: result.data });
      resetForm();
    } catch (e) {
      console.error(e);
      alert("Помилка збереження: немає з'єднання з сервером.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id) => {
    const tplToDelete = state.templates.find(t => t.id === id);
    const confirmed = await askConfirm({
      title: `Видалити шаблон «${tplToDelete ? tplToDelete.name : ''}»?`,
      message: 'Шаблон буде видалено разом з усіма його пунктами. Дію буде записано в журнал.'
    });
    if (!confirmed) return;
    setIsDeleting(id);
    try {
      const result = await callAction('deleteTemplate', { id }, sessionPin);
      if (!result.success) { alert(result.error || 'Помилка видалення шаблону.'); return; }
      dispatch({ type: 'DELETE_TEMPLATE', payload: id });
      if (editingId === id) resetForm();
    } catch (e) {
      console.error(e);
      alert("Помилка видалення: немає з'єднання з сервером.");
    } finally {
      setIsDeleting(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex justify-center items-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-slate-950 shrink-0">
          <h3 className="text-lg font-bold text-white flex items-center gap-2"><ClipboardList className="text-teal-500"/> Шаблони списання</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white bg-slate-800 p-2 rounded-full"><X size={18}/></button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <div>
            <h4 className="text-sm font-bold text-slate-300 mb-3">{editingId ? 'Редагування шаблону' : 'Новий шаблон'}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-1">
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Назва (напр. АКШ)" className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-teal-500"/>
              <select value={operationType} onChange={e => setOperationType(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none appearance-none"><option>CABG On-pump</option><option>CABG Off-pump</option><option>AVR (Аортальний клапан)</option><option>MVR (Мітральний клапан)</option><option>Bentall</option><option>Комбінована</option></select>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">Тип операції підставиться автоматично при застосуванні шаблону.</p>

            <div className="relative" ref={searchRef}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                <input
                  type="text" value={materialSearch}
                  onChange={e => { setMaterialSearch(e.target.value); setShowSuggestions(true); }}
                  onFocus={() => setShowSuggestions(true)}
                  placeholder="Пошук матеріалу з довідника для додавання в шаблон..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:ring-2 focus:ring-teal-500 placeholder:text-slate-600"
                />
              </div>
              {showSuggestions && materialSearch && (
                <div className="absolute z-10 w-full mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden max-h-48 overflow-y-auto">
                  {materialSuggestions.length > 0 ? materialSuggestions.map(mat => (
                    <div key={mat.id} onClick={() => addMaterial(mat)} className="p-2.5 hover:bg-slate-700 cursor-pointer border-b border-slate-700/50 last:border-0">
                      <p className="text-sm font-bold text-white">{mat.name}</p>
                      <p className="text-[10px] text-slate-400">{[mat.subcategory, mat.code].filter(Boolean).join(' · ') || '—'}</p>
                    </div>
                  )) : <div className="p-3 text-center text-xs text-slate-500">Нічого не знайдено в довіднику</div>}
                </div>
              )}
            </div>

            {items.length > 0 ? (
              <div className="mt-3 space-y-2">
                {items.map(item => (
                  <div key={item.material_id} className="flex justify-between items-center bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <p className="text-sm font-bold text-white">{item.name}</p>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center bg-slate-900 rounded-lg border border-slate-800">
                        <button onClick={() => setItems(prev => prev.map(i => i.material_id === item.material_id ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))} className="px-3 py-1 text-slate-400 hover:text-white">-</button>
                        <div className="px-3 py-1 text-white text-sm font-bold min-w-[2.5rem] text-center">{item.quantity}</div>
                        <button onClick={() => setItems(prev => prev.map(i => i.material_id === item.material_id ? { ...i, quantity: i.quantity + 1 } : i))} className="px-3 py-1 text-slate-400 hover:text-white">+</button>
                      </div>
                      <button onClick={() => setItems(prev => prev.filter(i => i.material_id !== item.material_id))} className="p-1.5 text-rose-500 hover:bg-rose-500/20 rounded-lg"><Trash2 size={16}/></button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 mt-3">Ще жодного матеріалу не додано.</p>
            )}

            <div className="flex gap-3 mt-4">
              <button onClick={handleSave} disabled={isSaving} className="flex-1 bg-teal-600 hover:bg-teal-500 text-white font-bold py-3 rounded-xl disabled:opacity-50">{isSaving ? 'Збереження...' : (editingId ? 'Оновити шаблон' : 'Зберегти шаблон')}</button>
              {editingId && <button onClick={resetForm} className="bg-slate-800 text-slate-300 font-bold py-3 px-5 rounded-xl">Скасувати</button>}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800">
            <h4 className="text-sm font-bold text-slate-300 mb-3">Наявні шаблони</h4>
            {(!state.templates || state.templates.length === 0) ? (
              <p className="text-sm text-slate-500">Ще немає жодного шаблону.</p>
            ) : (
              <div className="space-y-2">
                {state.templates.map(tpl => (
                  <div key={tpl.id} className="flex justify-between items-center bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <div>
                      <p className="text-sm font-bold text-white">{tpl.name}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{state.templateItems.filter(ti => ti.template_id === tpl.id).length} матеріалів{tpl.operation_type ? ` · ${tpl.operation_type}` : ''}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => startEdit(tpl)} className="p-2 text-slate-400 hover:text-teal-400 bg-slate-900 rounded-lg"><Edit2 size={16}/></button>
                      <button onClick={() => handleDelete(tpl.id)} disabled={isDeleting === tpl.id} className="p-2 text-slate-400 hover:text-rose-400 bg-slate-900 rounded-lg disabled:opacity-50"><Trash2 size={16}/></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
};

const PostOpExpense = ({ state, dispatch, sessionPin }) => {
  const [showImport, setShowImport] = useState(false);
  const [formData, setFormData] = useState({operation_num:"", patient_case_id:"", operation_type:"", date:""});
  const [expenses, setExpenses] = useState([]);
  const [scanMessage, setScanMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showTemplateManager, setShowTemplateManager] = useState(false);

  const showMsg = (type, text) => { setScanMessage({type, text}); setTimeout(() => setScanMessage(null), 4000); };

  const handleManualAdd = (batch, material) => {
    setExpenses(prev => {
      const existing = prev.find(e => e.stock_batch_id === batch.id);
      if (existing) {
        if (existing.quantity + 1 > batch.quantity) { showMsg('error', 'Перевищено доступний залишок!'); return prev; }
        showMsg('success', `Кількість збільшено: ${material.name}`);
        return prev.map(e => e.stock_batch_id === batch.id ? { ...e, quantity: e.quantity + 1 } : e);
      } else {
        showMsg('success', `Успішно додано: ${material.name}`);
        return [...prev, { id: genId('exp'), stock_batch_id: batch.id, material_id: material.id, name: material.name, lot: batch.lot_number, serial: batch.serial_number, size: batch.size, quantity: 1, max: batch.quantity }];
      }
    });
  };

  const handleApplyTemplate = (tpl) => {
    const tplItems = state.templateItems.filter(ti => ti.template_id === tpl.id);
    if (tplItems.length === 0) { showMsg('error', 'У цьому шаблоні немає матеріалів.'); return; }

    // Рахуємо весь план одразу (яку партію й скільки додати на кожен пункт шаблону),
    // виходячи з поточного кошика, і застосовуємо одним оновленням стану —
    // а не по одному setExpenses(prev => ...) на пункт.
    let workingCart = [...expenses];
    const problems = [];
    let addedCount = 0;

    tplItems.forEach(item => {
      const material = state.materials.find(m => m.id === item.material_id);
      if (!material) { problems.push('матеріал видалено з довідника'); return; }

      const batches = state.stock
        .filter(s => s.material_id === material.id && s.quantity > 0)
        .sort((a, b) => compareExpiry(a.expiration_date, b.expiration_date));
      if (batches.length === 0) { problems.push(`${material.name}: немає в наявності`); return; }

      const batch = batches[0];
      const existingIdx = workingCart.findIndex(e => e.stock_batch_id === batch.id);
      const already = existingIdx >= 0 ? workingCart[existingIdx].quantity : 0;
      const qtyToAdd = Math.min(Number(item.quantity), batch.quantity - already);
      if (qtyToAdd <= 0) { problems.push(`${material.name}: у кошику вже максимум доступного`); return; }

      if (existingIdx >= 0) {
        workingCart = workingCart.map((e, i) => i === existingIdx ? { ...e, quantity: e.quantity + qtyToAdd } : e);
      } else {
        workingCart = [...workingCart, { id: genId('exp'), stock_batch_id: batch.id, material_id: material.id, name: material.name, lot: batch.lot_number, serial: batch.serial_number, size: batch.size, quantity: qtyToAdd, max: batch.quantity }];
      }
      addedCount++;
      if (qtyToAdd < Number(item.quantity)) problems.push(`${material.name}: додано ${qtyToAdd} з ${item.quantity}`);
    });

    setExpenses(workingCart);
    if (tpl.operation_type) setFormData(prev => ({ ...prev, operation_type: tpl.operation_type }));

    if (problems.length > 0) showMsg('error', `"${tpl.name}": ${problems.join('; ')}`);
    else showMsg('success', `Шаблон "${tpl.name}" застосовано (${addedCount} поз.)`);
  };

  // Рядки, підготовлені імпортом з документа (партії вже розраховані й перевірені у вікні імпорту).
  const applyImportedLines = (lines, text) => {
    setExpenses(prev => {
      let cart = [...prev];
      lines.forEach(({ batch, material, qty }) => {
        const idx = cart.findIndex(e => e.stock_batch_id === batch.id);
        if (idx >= 0) cart = cart.map((e, i) => (i === idx ? { ...e, quantity: Math.min(e.max, e.quantity + qty) } : e));
        else cart.push({ id: genId('exp'), stock_batch_id: batch.id, material_id: material.id, name: material.name, lot: batch.lot_number, serial: batch.serial_number, size: batch.size, quantity: qty, max: batch.quantity });
      });
      return cart;
    });
    showMsg('success', text);
  };

  const submitOperation = async () => {
    // Обов'язковий лише № операції; ІБ, тип і дата — за бажанням (порожня дата = сьогодні, її ставить сервер).
    if (!formData.operation_num.trim()) { showMsg('error', "Вкажіть № операції."); return; }
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      const payload = {
        operation: {
          operation_num: formData.operation_num.trim(),
          patient_case_id: formData.patient_case_id.trim(),
          operation_date: formData.date,
          operation_type: formData.operation_type
        },
        expenses: expenses.map(e => ({ stock_batch_id: e.stock_batch_id, quantity: e.quantity }))
      };
      const result = await callAction('addOperation', payload, sessionPin);
      if (!result.success) { showMsg('error', result.error || 'Помилка збереження операції.'); return; }

      dispatch({ type: 'ADD_OPERATION', payload: result.data });
      setFormData({ operation_num: '', patient_case_id: '', operation_type: '', date: '' });
      setExpenses([]);
      showMsg('success', '✅ Операцію збережено, матеріали списано!');
    } catch (e) {
      console.error("Apps Script Error:", e);
      showMsg('error', "Помилка збереження: немає з'єднання з сервером.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      {showImport && <DocumentImportModal mode="writeoff" state={state} dispatch={dispatch} sessionPin={sessionPin} cart={expenses} onApply={applyImportedLines} onClose={() => setShowImport(false)} />}
      {showTemplateManager && <TemplateManagerModal state={state} dispatch={dispatch} sessionPin={sessionPin} onClose={() => setShowTemplateManager(false)} />}
      {scanMessage && (
        <div className={`p-4 rounded-2xl border flex items-center gap-3 shadow-lg ${scanMessage.type === 'error' ? 'bg-rose-950/80 border-rose-900 text-rose-200' : 'bg-teal-950/80 border-teal-900 text-teal-200'}`}>
          {scanMessage.type === 'error' ? <AlertTriangle size={20} className="text-rose-500" /> : <CheckCircle size={20} className="text-teal-500" />}
          <span className="font-medium text-sm">{scanMessage.text}</span>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-2xl">
        <h2 className="text-xl font-black text-white mb-8 flex items-center gap-3"><div className="p-2 bg-rose-500/10 rounded-xl text-rose-500"><Activity size={24} /></div>Списання на операцію</h2>

        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2"><ClipboardList size={14} className="text-teal-500"/> Шаблони списання</h3>
            <button onClick={() => setShowTemplateManager(true)} className="text-xs text-teal-400 hover:text-teal-300 font-bold flex items-center gap-1"><Edit2 size={12}/> Керувати шаблонами</button>
          </div>
          {state.templates && state.templates.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {state.templates.map(tpl => (
                <button key={tpl.id} onClick={() => handleApplyTemplate(tpl)} className="px-4 py-2 bg-slate-800 hover:bg-teal-600 border border-slate-700 hover:border-teal-500 rounded-xl text-sm font-bold text-white transition-colors">{tpl.name}</button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Ще немає жодного шаблону — натисніть "Керувати шаблонами", щоб створити перший (напр. "АКШ").</p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
          <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">№ Операції *</label><input type="text" value={formData.operation_num} onChange={e => setFormData({...formData, operation_num: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none font-mono" placeholder="Напр. 1024" /></div>
          <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">ID Пацієнта (ІБ)</label><input type="text" value={formData.patient_case_id} onChange={e => setFormData({...formData, patient_case_id: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none font-mono" placeholder="ІБ-2026/45" /></div>
          <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Тип операції</label><select value={formData.operation_type} onChange={e => setFormData({...formData, operation_type: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none appearance-none"><option value="">Не вказано</option><option>CABG On-pump</option><option>CABG Off-pump</option><option>AVR (Аортальний клапан)</option><option>MVR (Мітральний клапан)</option><option>Bentall</option><option>Комбінована</option></select></div>
          <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Дата</label><input type="date" value={formData.date} onChange={e => setFormData({...formData, date: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none" style={{colorScheme: 'dark'}} /></div>
        </div>

        <div className="bg-slate-950/50 p-5 rounded-2xl border border-slate-800 shadow-inner">
          <div className="flex flex-col gap-4 mb-5">
             <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2">Додати матеріали:</h3>
             <div className="flex flex-col sm:flex-row gap-3">
                <SearchableDropdown state={state} onSelect={handleManualAdd} />
                <button onClick={() => setShowImport(true)} className="w-full sm:w-auto bg-teal-600 hover:bg-teal-500 text-white px-5 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shrink-0"><Upload size={18} /> Імпорт з документа</button>
             </div>
          </div>

          {expenses.length === 0 ? (
            <div className="text-center py-10 text-slate-600 border-2 border-dashed border-slate-800 rounded-2xl"><FileText size={48} className="mx-auto mb-4 opacity-30" /><p className="text-sm font-medium">Шукайте у списку, оберіть шаблон або імпортуйте документ</p></div>
          ) : (
            <div className="space-y-3">
              {expenses.map((item) => (
                <div key={item.id} className="flex flex-col sm:flex-row justify-between sm:items-center bg-slate-900 p-4 rounded-xl border border-slate-700 shadow-md gap-4">
                  <div className="flex-1">
                    <p className="font-bold text-white text-sm">{item.name}</p>
                    <div className="flex gap-3 items-center mt-1.5">
                      {item.size && <span className="text-[10px] px-2 py-0.5 bg-teal-900/40 text-teal-400 rounded border border-teal-800 font-bold">Розмір: {item.size}</span>}
                      {item.lot && <span className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-400 rounded border border-slate-700 font-mono">LOT: {item.lot}</span>}
                      {item.serial && <span className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-400 rounded border border-slate-700 font-mono">SN: {item.serial}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 justify-between sm:justify-end">
                    <div className="flex items-center bg-slate-950 rounded-lg border border-slate-800">
                      <button onClick={() => setExpenses(prev => prev.map(e => e.id === item.id ? {...e, quantity: Math.max(1, e.quantity - 1)} : e))} className="px-3 py-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-l-lg">-</button>
                      <div className="px-3 py-1.5 text-white text-sm font-bold min-w-[3rem] text-center">{item.quantity} <span className="text-slate-500 text-xs font-normal">/ {item.max}</span></div>
                      <button onClick={() => setExpenses(prev => prev.map(e => e.id === item.id ? {...e, quantity: Math.min(e.max, e.quantity + 1)} : e))} className="px-3 py-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-r-lg">+</button>
                    </div>
                    <button onClick={() => setExpenses(prev => prev.filter(e => e.id !== item.id))} className="p-2 text-rose-500 hover:bg-rose-500/20 rounded-lg"><Trash2 size={20} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={submitOperation} disabled={expenses.length === 0 || isSubmitting} className={`w-full mt-6 py-4 rounded-2xl font-black text-lg transition-all duration-300 ${expenses.length > 0 && !isSubmitting ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-lg hover:scale-[1.01]' : 'bg-slate-950 text-slate-700 border border-slate-800 cursor-not-allowed'}`}>{isSubmitting ? 'Збереження...' : `Завершити операцію (${expenses.reduce((s,e) => s + e.quantity, 0)} шт)`}</button>
      </div>
    </div>
  );
};

// ---------- Імпорт з документа (PDF / Word / фото): прихід, списання, довідник ----------
// Потік: файл → розбір таблиці (documentImport.js) → зіставлення з довідником → ПЕРЕВІРКА і правки користувачем → підтвердження.
//   mode "stockin"  — прихід: один пакетний запит addStockBatch (усе або нічого);
//   mode "writeoff" — списання: лише наповнює кошик екрана "Списання на операцію" (на сервер нічого не йде,
//                     доки користувач не проведе операцію);
//   mode "catalog"  — довідник: пакетне створення НОВИХ матеріалів, addMaterialsBatch (усе або нічого).
// Нічого не змінюється без явного підтвердження користувача.
const IMPORT_ACCEPT = '.pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/*';
const EMPTY_CART = [];

const IMPORT_MODES = {
  stockin: {
    title: 'Імпорт приходу з документа',
    intro: 'PDF, Word (.docx) або фото накладної (JPG, PNG). Програма розбере таблицю й знайде вироби в довіднику, а ви перевірите й за потреби виправите дані перед додаванням на склад.',
    submit: 'Додати на склад',
    filters: [['all', 'Усі'], ['matched', 'Знайдені'], ['missing', 'Не знайдені'], ['selected', 'Відмічені']]
  },
  writeoff: {
    title: 'Імпорт списання з документа',
    intro: 'PDF, Word (.docx) або фото документа зі списком використаних матеріалів. Програма знайде їх у довіднику й запропонує партії зі складу, а ви перевірите кількості. Залишки на складі не зміняться, поки ви не проведете списання.',
    submit: 'Додати до списання',
    filters: [['all', 'Усі'], ['matched', 'Знайдені'], ['missing', 'Не знайдені'], ['selected', 'Відмічені']]
  },
  catalog: {
    title: 'Імпорт довідника з документа',
    intro: 'PDF, Word (.docx) або фото переліку виробів. Програма покаже, що вже є в довіднику, а яких виробів ще немає — їх можна відмітити й додати як нові матеріали.',
    submit: 'Додати в довідник',
    filters: [['all', 'Усі'], ['missing', 'Нові'], ['matched', 'Вже є'], ['selected', 'Відмічені']]
  }
};

const IMPORT_BADGES = {
  code:      { text: 'Збіг за артикулом',   cls: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  name:      { text: 'Збіг за назвою',      cls: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  similar:   { text: 'Схоже — перевірте',   cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  ambiguous: { text: 'Кілька збігів — оберіть', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  manual:    { text: 'Обрано вручну',       cls: 'bg-slate-700 text-slate-200 border-slate-600' },
  none:      { text: 'Не знайдено в довіднику', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  // режим довідника: "збіг" означає, що такий матеріал УЖЕ є
  exists:    { text: 'Вже є в довіднику',   cls: 'bg-slate-700 text-slate-200 border-slate-600' },
  existsMaybe: { text: 'Схоже на існуючий', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  isNew:     { text: 'Новий матеріал',      cls: 'bg-teal-500/10 text-teal-400 border-teal-500/30' }
};

const todayLocalStr = () => {
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

const buildImportRow = (item, match, index, mode) => {
  const base = {
    key: `imp${index}`,
    rowNo: item.rowNo, docName: item.name, unit: item.unit,
    requested: item.requested, issued: item.issued, qtySource: item.qtySource,
    materialId: match.materialId || '',
    kind: match.materialId ? match.kind : 'none',
    ambiguous: !!match.ambiguous,
    candidates: match.candidates || [],
    qty: item.qty === null || item.qty === undefined ? '' : String(item.qty),
    added: false
  };
  // довідник: відмічаємо те, чого ще НЕМАЄ (а те, що вже є, лишається невідміченим)
  if (mode === 'catalog') return { ...base, selected: !match.materialId, code: suggestCode(item), subcategory: '', minStock: '1' };
  // прихід і списання: автоматично відмічаємо лише впевнені збіги; "схожі" користувач відмічає сам
  const confident = (match.kind === 'code' || match.kind === 'name') && !match.ambiguous;
  if (mode === 'writeoff') return { ...base, selected: confident, batchChoice: 'auto' };
  return { ...base, selected: confident, lot: '', expiry: '' };
};

const importProblems = (r) => {
  const p = [];
  if (!r.materialId) p.push('material');
  if (!(Number(r.qty) > 0)) p.push('qty');
  return p; // LOT і термін придатності — за бажанням
};

const ImportMaterialPicker = ({ materials, value, candidates, onChange, invalid }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const byId = useMemo(() => { const m = {}; materials.forEach(x => { m[x.id] = x; }); return m; }, [materials]);
  const selected = byId[value];
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const src = t ? materials.filter(m => str(m.name).toLowerCase().includes(t) || str(m.code).toLowerCase().includes(t)) : materials;
    return src.slice(0, 8);
  }, [materials, q]);
  const suggestions = (candidates || []).filter(c => c.id !== value && byId[c.id]).slice(0, 3);

  return (
    <div className="space-y-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="Обрати матеріал з довідника"
        className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm flex items-center justify-between gap-2 bg-slate-950 ${invalid ? 'border-rose-500' : 'border-slate-800'} ${selected ? 'text-white' : 'text-slate-500'}`}>
        <span className="truncate">{selected ? `${selected.name}${str(selected.code) ? ` · ${selected.code}` : ''}` : 'Оберіть матеріал з довідника…'}</span>
        <Search size={14} className="shrink-0 text-slate-500" />
      </button>
      {!selected && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map(c => (
            <button key={c.id} type="button" onClick={() => onChange(c.id)} className="text-[11px] px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 max-w-full truncate">
              Схожий: {byId[c.id].name}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="rounded-xl border border-slate-700 bg-slate-950 p-2 space-y-1">
          <input autoFocus type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="Пошук за назвою чи кодом…" className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
          {list.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">Нічого не знайдено</div>}
          {list.map(m => (
            <button key={m.id} type="button" onClick={() => { onChange(m.id); setOpen(false); setQ(''); }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-sm text-slate-200">
              {m.name} <span className="text-slate-500">{str(m.code) ? `· ${m.code}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const DocumentImportModal = ({ state, dispatch, sessionPin, onClose, mode = 'stockin', cart, onApply }) => {
  const cfg = IMPORT_MODES[mode] || IMPORT_MODES.stockin;
  const [askConfirm, confirmDialog] = useConfirm();
  const [phase, setPhase] = useState('pick'); // pick | parsing | review
  const [progress, setProgress] = useState({ label: '', pct: null });
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('all');
  const [bulkExpiry, setBulkExpiry] = useState('');
  const [bulkSubcategory, setBulkSubcategory] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [addedCount, setAddedCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const [aiText, setAiText] = useState('');           // текст, який розпізнав AI (для звірки)
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const lastFileRef = useRef(null);                   // останній обраний файл — для кнопки «Зчитати з AI»
  const runRef = useRef(0);                           // номер поточного запуску: «Скасувати» робить його результат застарілим
  const phaseBeforeRef = useRef('pick');              // куди повернутись після «Скасувати»
  const aiConsentRef = useRef(false);                 // підтвердження «фото піде в Google» — один раз за відкриття вікна
  const previewRef = useRef('');

  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);
  useEffect(() => () => { runRef.current++; }, []);

  const setPreview = (url) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url; setPreviewUrl(url);
  };

  const reset = () => {
    setPhase('pick'); setRows([]); setWarnings([]); setError(''); setSaveError(''); setShowErrors(false);
    setFileName(''); setSource(''); setAddedCount(0); setFilter('all'); setShowOriginal(false); setPreview('');
    setAiText(''); lastFileRef.current = null; runRef.current++;
  };

  // Спільне для обох способів читання: показати розібрану таблицю на перевірку.
  const showParsed = (parsed, file) => {
    const matches = matchItems(parsed.items, state.materials);
    setRows(matches.map(({ item, match }, i) => buildImportRow(item, match, i, mode)));
    setWarnings(parsed.warnings || []); setSource(parsed.source || ''); setAddedCount(0); setFilter('all'); setShowErrors(false);
    setAiText(parsed.text || '');
    setPreview((file.type || '').startsWith('image/') ? URL.createObjectURL(file) : '');
    setPhase('review');
  };

  const handleFile = async (file) => {
    if (!file) return;
    lastFileRef.current = file;
    phaseBeforeRef.current = 'pick';
    const run = ++runRef.current;
    setError(''); setSaveError(''); setPhase('parsing'); setFileName(file.name || 'документ');
    setProgress({ label: 'Починаю…', pct: null });
    try {
      const parsed = await parseDocumentFile(file, { onProgress: (p) => { if (run === runRef.current) setProgress(p); } });
      if (run !== runRef.current) return; // користувач натиснув «Скасувати»
      showParsed(parsed, file);
    } catch (e) {
      if (run !== runRef.current) return;
      console.error('Помилка розбору документа:', e);
      setError(e.message || 'Не вдалося розібрати документ.');
      setPhase('pick');
    }
  };

  // «Зчитати з AI»: те саме фото розпізнає Google Cloud Vision (через сервер застосунку). Лише за кнопкою.
  const handleAiRead = async () => {
    const file = lastFileRef.current;
    if (!file || phase === 'parsing' || addedCount > 0) return;
    const replacing = phase === 'review';
    if (!aiConsentRef.current || replacing) {
      const parts = [];
      if (!aiConsentRef.current) parts.push('Фото буде надіслано через сервер застосунку до сервісу Google Cloud Vision для розпізнавання тексту. Якщо на фото є дані пацієнтів, а правила відділення забороняють передавати їх у хмару, — не користуйтеся цією кнопкою.');
      if (replacing) parts.push('Поточну таблицю й усі ваші правки буде замінено результатом AI.');
      const ok = await askConfirm({ title: 'Зчитати фото за допомогою AI?', message: parts.join('\n\n'), confirmLabel: 'Зчитати з AI' });
      if (!ok) return;
      aiConsentRef.current = true;
    }
    phaseBeforeRef.current = replacing ? 'review' : 'pick';
    const run = ++runRef.current;
    setError(''); setSaveError(''); setPhase('parsing'); setFileName(file.name || 'фото');
    setProgress({ label: 'Починаю…', pct: null });
    try {
      const parsed = await parseImageWithAi(file, {
        callOcr: (payload) => callAction('ocrImage', payload, sessionPin),
        onProgress: (p) => { if (run === runRef.current) setProgress(p); },
        isCancelled: () => run !== runRef.current
      });
      if (run !== runRef.current) return;
      showParsed(parsed, file);
    } catch (e) {
      if (run !== runRef.current) return;
      console.error('Помилка AI-розпізнавання:', e);
      const text = e.message || 'AI-розпізнавання не вдалося.';
      if (replacing) {
        // Попередній результат лишається як був — лише попереджаємо.
        setWarnings(prev => [`AI не вдалося: ${text}`, ...prev]);
        setPhase('review');
      } else {
        setError(text);
        setPhase('pick');
      }
    }
  };

  const cancelParsing = () => { runRef.current++; setError(''); setPhase(phaseBeforeRef.current); };

  // Кнопка «Зчитати з AI» доступна лише для фото й поки в довідник/склад нічого не додано з цього розбору.
  const canAi = !!lastFileRef.current && detectKind(lastFileRef.current) === 'image' && addedCount === 0;

  const onFileChosen = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; handleFile(f); };

  const patchRow = (key, patch) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));

  // Користувач виправив назву з документа → шукаємо збіг заново (якщо матеріал не обрано вручну).
  const rematch = (key) => setRows(prev => prev.map(r => {
    if (r.key !== key || r.kind === 'manual' || r.added) return r;
    const m = matchItem({ name: r.docName, code: '' }, state.materials);
    return {
      ...r, materialId: m.materialId || '', kind: m.materialId ? m.kind : 'none', ambiguous: !!m.ambiguous, candidates: m.candidates,
      selected: mode === 'catalog' ? r.selected : (m.materialId ? r.selected : false)
    };
  }));

  const today = todayLocalStr();
  const materialsById = useMemo(() => { const m = {}; state.materials.forEach(x => { m[x.id] = x; }); return m; }, [state.materials]);
  const subcatNames = (state.subcategories || []).map(sc => sc.name);

  // списання: з яких партій і скільки (рахується по всіх відмічених рядках разом, з урахуванням кошика)
  const cartLines = cart || EMPTY_CART;
  const plans = useMemo(() => (mode === 'writeoff' ? planWriteoffRows(rows, state.stock, cartLines, today) : {}), [mode, rows, state.stock, cartLines, today]);

  // довідник: коди, що вже зайняті, і повтори серед відмічених
  const existingCodes = useMemo(() => new Set(state.materials.map(m => normalizeCode(m.code)).filter(Boolean)), [state.materials]);
  const chosen = rows.filter(r => r.selected && !r.added);
  const chosenCodeCount = {};
  if (mode === 'catalog') chosen.forEach(r => { const c = normalizeCode(r.code); if (c) chosenCodeCount[c] = (chosenCodeCount[c] || 0) + 1; });

  const problemsFor = (r) => {
    if (mode === 'stockin') return importProblems(r);
    if (mode === 'writeoff') {
      const p = [];
      if (!r.materialId) p.push('material');
      if (!(Number(r.qty) > 0)) p.push('qty');
      const pl = plans[r.key];
      if (pl && !['ok', 'no_material', 'bad_qty'].includes(pl.status)) p.push('batch');
      return p;
    }
    // Обов'язкова лише назва. Код — за бажанням, але якщо вказано, він не може збігатися з наявним чи з іншим рядком.
    const p = [];
    if (!r.docName.trim()) p.push('name');
    const code = normalizeCode(r.code);
    if (code) {
      if (existingCodes.has(code)) p.push('code_exists');
      else if (chosenCodeCount[code] > 1) p.push('code_dup');
    }
    if (r.minStock !== '' && !(Number(r.minStock) >= 0)) p.push('min');
    return p;
  };

  const planText = (pl, r) => {
    if (!pl) return '';
    if (pl.status === 'ok') return 'Буде списано: ' + pl.lines.map(l => `LOT ${l.batch.lot_number} ×${l.qty} (до ${l.batch.expiration_date || '—'})`).join(' + ');
    if (pl.status === 'shortage') return pl.expiredOnly ? 'Є лише прострочені партії — оберіть партію вручну, якщо це свідомо.' : `Недостатньо залишку: потрібно ${Number(r.qty)}, доступно ${pl.available}.`;
    if (pl.status === 'no_stock') return 'На складі немає в наявності.';
    if (pl.status === 'manual_required') return 'Є партії з розміром чи серійним номером — оберіть конкретну партію.';
    if (pl.status === 'batch_gone') return 'Обрана партія вже недоступна.';
    return '';
  };

  const counts = {
    all: rows.length,
    matched: rows.filter(r => r.materialId).length,
    missing: rows.filter(r => !r.materialId).length,
    selected: chosen.length
  };
  const visibleRows = rows.filter(r => (filter === 'matched' ? !!r.materialId : filter === 'missing' ? !r.materialId : filter === 'selected' ? (r.selected && !r.added) : true));
  const totalQty = chosen.reduce((n, r) => n + (Number(r.qty) > 0 ? Number(r.qty) : 0), 0);

  const applyBulkExpiry = () => {
    if (!bulkExpiry) return;
    setRows(prev => prev.map(r => (r.selected && !r.added && !r.expiry ? { ...r, expiry: bulkExpiry } : r)));
  };
  const applyBulkSubcategory = () => {
    if (!bulkSubcategory) return;
    setRows(prev => prev.map(r => (r.selected && !r.added && !r.subcategory ? { ...r, subcategory: bulkSubcategory } : r)));
  };

  const markAdded = (keys) => {
    setRows(prev => prev.map(r => (keys.has(r.key) ? { ...r, added: true, selected: false } : r)));
    setAddedCount(n => n + keys.size);
    setShowErrors(false);
  };

  const reportServerError = (result) => {
    const bad1 = typeof result.rowIndex === 'number' ? chosen[result.rowIndex] : null;
    setSaveError(bad1 ? `${String(result.error).replace(/^Рядок \d+:\s*/, '')} — «${bad1.docName}»` : (result.error || 'Не вдалося зберегти.'));
  };

  const handleSubmit = async () => {
    if (isSaving) return;
    setShowErrors(true); setSaveError('');
    if (chosen.length === 0) { setSaveError('Відмітьте хоча б одну позицію.'); return; }
    const bad = chosen.filter(r => problemsFor(r).length > 0);
    if (bad.length > 0) {
      setSaveError(mode === 'stockin' ? `Заповніть обов'язкові поля (матеріал і кількість) у ${bad.length} поз. — вони підсвічені.`
        : mode === 'writeoff' ? `Виправте ${bad.length} поз.: перевірте матеріал, кількість і партію — вони підсвічені.`
        : `Виправте ${bad.length} поз.: потрібна назва, а код не має повторювати наявний — вони підсвічені.`);
      return;
    }

    if (mode === 'writeoff') {
      const withExpired = chosen.filter(r => plans[r.key] && plans[r.key].usesExpired);
      if (withExpired.length > 0) {
        const ok = await askConfirm({ title: 'Обрано прострочені партії', message: `У ${withExpired.length} поз. списання йде з простроченої партії. Додати до списання все одно?`, confirmLabel: 'Додати все одно' });
        if (!ok) return;
      }
      const lines = chosen.flatMap(r => plans[r.key].lines.map(l => ({ batch: l.batch, material: materialsById[r.materialId], qty: l.qty })));
      if (onApply) onApply(lines, `Додано з документа: ${chosen.length} поз. (${lines.length} партій)`);
      onClose();
      return;
    }

    if (mode === 'stockin') {
      const expired = chosen.filter(r => r.expiry && r.expiry < today);
      if (expired.length > 0) {
        const ok = await askConfirm({
          title: 'Є прострочені партії',
          message: `У ${expired.length} поз. термін придатності вже минув — це може бути помилка в даті. Додати все одно?`,
          confirmLabel: 'Додати все одно'
        });
        if (!ok) return;
      }
    }

    setIsSaving(true);
    try {
      if (mode === 'stockin') {
        const items = chosen.map(r => ({ material_id: r.materialId, lot_number: r.lot.trim(), expiration_date: r.expiry, quantity: Number(r.qty) }));
        const result = await callAction('addStockBatch', { items, source: fileName }, sessionPin);
        if (!result.success) { reportServerError(result); return; }
        result.data.batches.forEach(b => dispatch({ type: 'ADD_STOCK', payload: b }));
      } else {
        const items = chosen.map(r => ({ name: r.docName.trim(), code: r.code.trim(), subcategory: r.subcategory, min_stock: Number(r.minStock) || 0 }));
        const result = await callAction('addMaterialsBatch', { items, source: fileName }, sessionPin);
        if (!result.success) { reportServerError(result); return; }
        result.data.materials.forEach(mm => dispatch({ type: 'ADD_MATERIAL', payload: mm }));
      }
      markAdded(new Set(chosen.map(r => r.key)));
    } catch (e) {
      console.error(e);
      setSaveError(e.message || "Немає з'єднання з сервером.");
    } finally {
      setIsSaving(false);
    }
  };

  const badgeFor = (r) => {
    if (mode === 'catalog') return !r.materialId ? IMPORT_BADGES.isNew : (r.kind === 'similar' || r.ambiguous ? IMPORT_BADGES.existsMaybe : IMPORT_BADGES.exists);
    return r.ambiguous && r.materialId ? IMPORT_BADGES.ambiguous : IMPORT_BADGES[r.kind];
  };

  const isOcr = source.includes('ocr');
  const inputCls = (bad) => `w-full bg-slate-950 border rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-teal-500 ${bad ? 'border-rose-500' : 'border-slate-800'}`;
  const addedLabel = mode === 'catalog' ? 'Додано в довідник' : 'Додано на склад';

  const qtyField = (r, probs) => (
    <div>
      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Кількість{r.unit ? `, ${r.unit}` : ''}</label>
      <input type="number" min="0" step="any" value={r.qty} onChange={e => patchRow(r.key, { qty: e.target.value })} aria-label="Кількість" className={inputCls(probs.includes('qty'))} />
      {(r.requested || r.issued) && (
        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
          {r.requested ? <button type="button" onClick={() => patchRow(r.key, { qty: String(r.requested) })} className="underline hover:text-slate-300">вимагається {r.requested}</button> : null}
          {r.issued ? <button type="button" onClick={() => patchRow(r.key, { qty: String(r.issued) })} className="underline hover:text-slate-300">відпущено {r.issued}</button> : null}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-sm z-50 flex justify-center items-stretch md:items-center p-0 md:p-4">
      <div className="bg-slate-900 border border-slate-800 w-full max-w-4xl md:rounded-3xl shadow-2xl flex flex-col h-full md:h-[92vh]">
        <div className="shrink-0 flex items-center justify-between gap-3 p-4 md:p-5 border-b border-slate-800">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-white flex items-center gap-2"><FileText size={20} className="text-teal-500 shrink-0" /> {cfg.title}</h3>
            {phase === 'review' && <p className="text-xs text-slate-500 mt-0.5 truncate">{fileName}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {phase === 'review' && <button onClick={reset} className="text-xs font-bold text-slate-400 hover:text-white px-3 py-2 rounded-xl bg-slate-800">Інший файл</button>}
            <button onClick={onClose} aria-label="Закрити" className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800"><X size={20} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {phase === 'pick' && (
            <div className="p-6 md:p-10 flex flex-col items-center text-center gap-5">
              <div className="p-4 bg-teal-500/10 rounded-2xl text-teal-400"><FileText size={36} /></div>
              <div className="max-w-md space-y-2">
                <h4 className="text-white font-bold text-lg">Оберіть документ</h4>
                <p className="text-sm text-slate-400">{cfg.intro}</p>
              </div>
              {error && <div role="alert" className="max-w-md w-full bg-rose-950/60 border border-rose-900 text-rose-200 text-sm rounded-xl p-4 text-left flex gap-3"><AlertTriangle size={18} className="shrink-0 mt-0.5" /> {error}</div>}
              {error && canAi && (
                <div className="max-w-md w-full space-y-2">
                  <button onClick={handleAiRead} data-testid="import-ai" className="w-full bg-slate-800 hover:bg-slate-700 text-teal-400 font-bold px-6 py-3 rounded-xl flex items-center justify-center gap-2 border border-slate-700"><Sparkles size={18} /> Зчитати з AI</button>
                  <p className="text-xs text-slate-500">Для складних фото: розпізнає Google Cloud Vision. Фото буде надіслано в Google.</p>
                </div>
              )}
              {state.materials.length === 0 && mode !== 'catalog' && <div className="max-w-md w-full bg-amber-950/60 border border-amber-900 text-amber-200 text-sm rounded-xl p-4 text-left">Довідник порожній: спершу додайте матеріали у вкладці «Довідник».</div>}
              <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                <button onClick={() => fileInputRef.current && fileInputRef.current.click()} className="bg-teal-600 hover:bg-teal-500 text-white font-bold px-6 py-3 rounded-xl flex items-center justify-center gap-2"><Upload size={18} /> Обрати файл</button>
                <button onClick={() => cameraInputRef.current && cameraInputRef.current.click()} className="bg-slate-800 hover:bg-slate-700 text-teal-400 font-bold px-6 py-3 rounded-xl flex items-center justify-center gap-2 border border-slate-700"><Camera size={18} /> Сфотографувати</button>
              </div>
              <input ref={fileInputRef} type="file" accept={IMPORT_ACCEPT} className="hidden" onChange={onFileChosen} data-testid="import-file" />
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChosen} data-testid="import-camera" />
              <p className="text-xs text-slate-500 max-w-md">Файл обробляється у вашому браузері й нікуди не надсилається — окрім випадку, коли ви самі натиснете «Зчитати з AI» (тоді фото йде на розпізнавання в Google Cloud). Фото розпізнаються гірше за PDF/Word — такі результати завжди звіряйте з оригіналом.</p>
            </div>
          )}

          {phase === 'parsing' && (
            <div className="p-10 flex flex-col items-center gap-4 text-center" role="status">
              <RefreshCw size={32} className="text-teal-500 animate-spin" />
              <p className="text-white font-bold">{progress.label || 'Обробка…'}</p>
              {progress.pct !== null && progress.pct !== undefined && (
                <div className="w-full max-w-xs h-2 bg-slate-800 rounded-full overflow-hidden"><div className="h-full bg-teal-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
              )}
              <p className="text-xs text-slate-500">{fileName}</p>
              <button onClick={cancelParsing} data-testid="import-cancel" className="text-sm font-bold text-slate-300 hover:text-white px-5 py-2.5 rounded-xl bg-slate-800">Скасувати</button>
            </div>
          )}

          {phase === 'review' && (
            <div className="p-4 md:p-5 space-y-4">
              {warnings.length > 0 && (
                <div className={`rounded-xl border p-4 text-sm space-y-1 ${isOcr ? 'bg-rose-950/40 border-rose-900 text-rose-200' : 'bg-amber-950/40 border-amber-900 text-amber-200'}`} role="alert">
                  {warnings.map((w, i) => <div key={i} className="flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" /> {w}</div>)}
                </div>
              )}
              {source === 'image-ocr' && canAi && (
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                  <p className="text-sm text-slate-400">Результат неточний або бракує рядків? Спробуйте розпізнати це фото за допомогою AI (фото буде надіслано в Google Cloud Vision).</p>
                  <button onClick={handleAiRead} data-testid="import-ai-review" className="shrink-0 bg-slate-800 hover:bg-slate-700 text-teal-400 font-bold text-sm px-4 py-2.5 rounded-xl flex items-center justify-center gap-2 border border-slate-700"><Sparkles size={16} /> Зчитати з AI</button>
                </div>
              )}
              {previewUrl && (
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                  <button onClick={() => setShowOriginal(v => !v)} className="text-sm font-bold text-teal-400 hover:text-teal-300">{showOriginal ? 'Сховати оригінал' : 'Показати оригінал для звірки'}</button>
                  {showOriginal && <a href={previewUrl} target="_blank" rel="noreferrer" className="block mt-3"><img src={previewUrl} alt="Оригінал документа" className="w-full max-h-96 object-contain rounded-lg bg-white" /></a>}
                </div>
              )}
              {aiText && (
                <details className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                  <summary className="text-sm font-bold text-teal-400 cursor-pointer">Текст, який розпізнав AI</summary>
                  <pre className="mt-3 text-xs text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto">{aiText}</pre>
                </details>
              )}
              {addedCount > 0 && <div className="rounded-xl border border-teal-900 bg-teal-950/40 text-teal-200 text-sm p-4 flex gap-2" role="status"><CheckCircle size={18} className="shrink-0" /> {addedLabel}: {addedCount} поз.</div>}

              <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
                <div className="flex flex-wrap gap-2">
                  {cfg.filters.map(([id, label]) => (
                    <button key={id} onClick={() => setFilter(id)} aria-pressed={filter === id} className={`px-3 py-2 rounded-xl text-xs font-bold border ${filter === id ? 'bg-teal-500/10 text-teal-400 border-teal-500/30' : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'}`}>{label} ({counts[id]})</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <button onClick={() => setRows(prev => prev.map(r => (!r.added && (mode === 'catalog' ? !r.materialId : r.materialId) ? { ...r, selected: true } : r)))} className="text-xs font-bold text-slate-300 hover:text-white px-3 py-2 rounded-xl bg-slate-800">{mode === 'catalog' ? 'Відмітити всі нові' : 'Відмітити всі знайдені'}</button>
                  <button onClick={() => setRows(prev => prev.map(r => ({ ...r, selected: false })))} className="text-xs font-bold text-slate-300 hover:text-white px-3 py-2 rounded-xl bg-slate-800">Зняти всі</button>
                </div>
              </div>

              {mode === 'stockin' && (
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <label className="text-xs text-slate-400 font-bold" htmlFor="bulk-expiry">Однаковий термін придатності для відмічених без дати:</label>
                  <input id="bulk-expiry" type="date" value={bulkExpiry} onChange={e => setBulkExpiry(e.target.value)} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                  <button onClick={applyBulkExpiry} disabled={!bulkExpiry} className="text-xs font-bold text-white px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40">Застосувати</button>
                </div>
              )}
              {mode === 'catalog' && (
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <label className="text-xs text-slate-400 font-bold" htmlFor="bulk-subcat">Підкатегорія для відмічених без вибору:</label>
                  <select id="bulk-subcat" value={bulkSubcategory} onChange={e => setBulkSubcategory(e.target.value)} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none">
                    <option value="">Оберіть…</option>
                    {subcatNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button onClick={applyBulkSubcategory} disabled={!bulkSubcategory} className="text-xs font-bold text-white px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40">Застосувати</button>
                </div>
              )}

              <div className="space-y-3">
                {visibleRows.length === 0 && <div className="text-center text-sm text-slate-500 py-8">Немає рядків за цим фільтром.</div>}
                {visibleRows.map(r => {
                  const probs = showErrors && r.selected && !r.added ? problemsFor(r) : [];
                  const badge = badgeFor(r);
                  const expired = mode === 'stockin' && r.expiry && r.expiry < today;
                  const existing = mode === 'catalog' && r.materialId ? materialsById[r.materialId] : null;
                  const plan = mode === 'writeoff' && r.selected && !r.added ? plans[r.key] : null;
                  const rowBatches = mode === 'writeoff' && r.materialId ? availableBatches(state.stock, r.materialId, today) : [];
                  return (
                    <div key={r.key} data-testid="import-row" className={`rounded-2xl border p-4 ${r.added ? 'opacity-50 border-teal-900 bg-slate-900' : r.selected ? 'border-teal-500/40 bg-slate-900' : 'border-slate-800 bg-slate-900/60'}`}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" checked={r.selected} disabled={r.added} onChange={e => patchRow(r.key, { selected: e.target.checked })} aria-label={`Додати: ${r.docName}`} className="mt-1 h-5 w-5 accent-teal-500 shrink-0" />
                        <div className="flex-1 min-w-0 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] text-slate-500 font-mono shrink-0">№{r.rowNo || '—'}</span>
                            <input type="text" value={r.docName} disabled={r.added} onChange={e => patchRow(r.key, { docName: e.target.value })} onBlur={() => rematch(r.key)} aria-label={mode === 'catalog' ? 'Назва матеріалу' : 'Назва в документі'} className={`flex-1 min-w-[12rem] bg-transparent border-b focus:border-teal-500 text-sm text-white outline-none py-1 ${probs.includes('name') ? 'border-rose-500' : 'border-slate-800'}`} />
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${r.added ? 'bg-teal-500/10 text-teal-400 border-teal-500/30' : badge.cls}`}>{r.added ? 'Додано' : badge.text}</span>
                          </div>

                          {existing && !r.added && <div className="text-xs text-amber-300/90">{r.kind === 'similar' || r.ambiguous ? 'Схоже на' : 'Вже є в довіднику'}: {existing.name}{str(existing.code) ? ` · ${existing.code}` : ''}</div>}
                          {mode !== 'catalog' && !r.added && <ImportMaterialPicker materials={state.materials} value={r.materialId} candidates={r.candidates} invalid={probs.includes('material')} onChange={id => patchRow(r.key, { materialId: id, kind: 'manual', ambiguous: false, selected: true, batchChoice: 'auto' })} />}

                          {mode === 'stockin' && !r.added && (
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                              {qtyField(r, probs)}
                              <div>
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">LOT / партія</label>
                                <input type="text" value={r.lot} onChange={e => patchRow(r.key, { lot: e.target.value })} aria-label="LOT" className={inputCls(probs.includes('lot'))} />
                              </div>
                              <div className="col-span-2 md:col-span-1">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Придатний до</label>
                                <input type="date" value={r.expiry} onChange={e => patchRow(r.key, { expiry: e.target.value })} aria-label="Придатний до" className={inputCls(probs.includes('expiry'))} />
                                {expired && <div className="mt-1 text-[10px] text-amber-400">термін уже минув</div>}
                              </div>
                            </div>
                          )}

                          {mode === 'writeoff' && !r.added && (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                {qtyField(r, probs)}
                                <div className="col-span-2">
                                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Партія</label>
                                  <select value={r.batchChoice} onChange={e => patchRow(r.key, { batchChoice: e.target.value })} aria-label="Партія" disabled={!r.materialId} className={inputCls(probs.includes('batch'))}>
                                    <option value="auto" disabled={!isAutoAllocatable(rowBatches)}>Автоматично (спершу з найближчим терміном)</option>
                                    {rowBatches.map(b => (
                                      <option key={b.id} value={b.id}>LOT {b.lot_number}{b.size ? ` · розмір ${b.size}` : ''}{b.serial_number ? ` · SN ${b.serial_number}` : ''} · до {b.expiration_date || '—'} · залишок {b.quantity}{b.expired ? ' · ПРОСТРОЧЕНО' : ''}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                              {plan && planText(plan, r) && <div className={`text-xs ${plan.status === 'ok' ? (plan.usesExpired ? 'text-amber-400' : 'text-teal-300') : 'text-rose-300'}`} data-testid="import-plan">{planText(plan, r)}{plan.usesExpired ? ' (прострочена партія!)' : ''}</div>}
                            </div>
                          )}

                          {mode === 'catalog' && !r.added && (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                <div>
                                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Артикул / код</label>
                                  <input type="text" value={r.code} onChange={e => patchRow(r.key, { code: e.target.value })} aria-label="Артикул / код" className={`${inputCls(probs.includes('code') || probs.includes('code_exists') || probs.includes('code_dup'))} font-mono`} />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Підкатегорія</label>
                                  <select value={r.subcategory} onChange={e => patchRow(r.key, { subcategory: e.target.value })} aria-label="Підкатегорія" className={inputCls(false)}>
                                    <option value="">Без підкатегорії</option>
                                    {subcatNames.map(n => <option key={n} value={n}>{n}</option>)}
                                  </select>
                                </div>
                                <div className="col-span-2 md:col-span-1">
                                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Мін. залишок</label>
                                  <input type="number" min="0" value={r.minStock} onChange={e => patchRow(r.key, { minStock: e.target.value })} aria-label="Мін. залишок" className={inputCls(probs.includes('min'))} />
                                </div>
                              </div>
                              {probs.includes('code_exists') && <div className="text-xs text-rose-300">Такий код уже є в довіднику — змініть код або зніміть позначку.</div>}
                              {probs.includes('code_dup') && <div className="text-xs text-rose-300">Цей код повторюється серед відмічених рядків.</div>}
                              {!r.code.trim() && r.selected && <div className="text-xs text-slate-500">Артикул у документі не знайдено — код можна залишити порожнім.</div>}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {phase === 'review' && (
          <div className="shrink-0 border-t border-slate-800 p-4 md:p-5 space-y-3">
            {saveError && <div role="alert" className="bg-rose-950/60 border border-rose-900 text-rose-200 text-sm rounded-xl p-3 flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" /> {saveError}</div>}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-sm text-slate-400" data-testid="import-summary">Відмічено: <span className="text-white font-bold">{chosen.length}</span> поз.{mode !== 'catalog' && <> · усього <span className="text-white font-bold">{totalQty}</span> шт</>}</p>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold">Закрити</button>
                <button onClick={handleSubmit} disabled={isSaving || chosen.length === 0} className="px-5 py-3 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold disabled:opacity-40 flex items-center gap-2">{isSaving ? 'Додаю…' : cfg.submit}</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  );
};

const StockIn = ({ state, dispatch, sessionPin }) => {
  const [showImport, setShowImport] = useState(false);
  // Матеріал обирається за id (а не за кодом): код тепер необов'язковий, тож у кількох матеріалів він може бути порожнім.
  const [materialId, setMaterialId] = useState('');
  const [formData, setFormData] = useState({ lot: '', serial: '', size: '', exp: '', quantity: 1 });
  const [message, setMessage] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setShowDropdown(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeMaterial = state.materials.find(m => m.id === materialId);
  const showMsg = (type, text) => { setMessage({type, text}); setTimeout(() => setMessage(null), 4000); };

  const filteredMaterials = useMemo(() => {
    if (!searchQuery) return state.materials.slice(0, 10);
    const query = searchQuery.toLowerCase();
    return state.materials.filter(m =>
      str(m.name).toLowerCase().includes(query) || str(m.code).toLowerCase().includes(query)
    ).slice(0, 10);
  }, [searchQuery, state.materials]);

  const handleSelectMaterial = (mat) => {
    setMaterialId(mat.id);
    setSearchQuery(mat.name);
    setShowDropdown(false);
  };

  // Введений текст дорівнює коду матеріалу (так працює й USB-сканер, що "набирає" код) — обираємо його автоматично.
  const handleSearchChange = (value) => {
    setSearchQuery(value);
    const exact = value ? state.materials.find(m => str(m.code) && m.code === value) : null;
    setMaterialId(exact ? exact.id : '');
    setShowDropdown(true);
  };

  const handleSave = async () => {
    // Обов'язкові лише матеріал і кількість. LOT і термін придатності — за бажанням.
    if (!activeMaterial) { showMsg('error', "Оберіть матеріал зі списку. Якщо його немає — спершу додайте його в довідник."); return; }
    if (!(Number(formData.quantity) > 0)) { showMsg('error', "Вкажіть кількість більше нуля."); return; }
    if (isSaving) return;

    setIsSaving(true);
    try {
      const result = await callAction('addStock', {
        material_id: activeMaterial.id,
        lot_number: formData.lot.trim(),
        serial_number: formData.serial,
        size: formData.size,
        expiration_date: formData.exp,
        quantity: Number(formData.quantity)
      }, sessionPin);
      if (!result.success) { showMsg('error', result.error || 'Помилка оприбуткування.'); return; }

      dispatch({ type: 'ADD_STOCK', payload: result.data });
      setFormData({ lot: '', serial: '', size: '', exp: '', quantity: 1 });
      setMaterialId('');
      setSearchQuery('');
      showMsg('success', '✅ Товар успішно оприбутковано на склад!');
    } catch (e) {
      console.error(e);
      showMsg('error', "Помилка збереження: немає з'єднання з сервером.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto animate-in slide-in-from-bottom-4 duration-500">
      {showImport && <DocumentImportModal state={state} dispatch={dispatch} sessionPin={sessionPin} onClose={() => setShowImport(false)} />}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-2xl">
         <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
            <h2 className="text-xl font-black text-white flex items-center gap-3"><div className="p-2 bg-teal-500/10 rounded-xl text-teal-500"><PackagePlus size={24} /></div>Прихід товару</h2>
            <button onClick={() => setShowImport(true)} className="w-full sm:w-auto bg-slate-800 hover:bg-slate-700 text-teal-400 px-5 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors border border-slate-700"><Upload size={18} /> Імпорт з документа</button>
         </div>
         {message && <div className={`p-4 rounded-xl border mb-6 flex items-center gap-3 text-sm font-medium ${message.type === 'error' ? 'bg-rose-950/80 border-rose-900 text-rose-200' : message.type === 'warning' ? 'bg-amber-950/80 border-amber-900 text-amber-200' : 'bg-teal-950/80 border-teal-900 text-teal-200'}`}><AlertTriangle size={18}/> {message.text}</div>}

         <div className="space-y-5">
            <div className="space-y-1.5" ref={dropdownRef}>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Матеріал (Пошук або Код) *</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                <input
                  type="text" value={searchQuery}
                  onChange={e => handleSearchChange(e.target.value)}
                  onFocus={() => setShowDropdown(true)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 pl-10 text-teal-400 focus:ring-2 focus:ring-teal-500 outline-none font-bold tracking-wide"
                  placeholder="Введіть назву або код..."
                />
                {showDropdown && (
                  <div className="absolute z-50 w-full mt-2 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden max-h-60 overflow-y-auto">
                    {filteredMaterials.length > 0 ? filteredMaterials.map(mat => (
                      <div key={mat.id} onClick={() => handleSelectMaterial(mat)} className="p-3 hover:bg-slate-700 cursor-pointer border-b border-slate-700/50 last:border-0 flex justify-between items-center group">
                        <div>
                          <p className="text-sm font-bold text-white group-hover:text-teal-300 transition-colors">{mat.name}</p>
                          {mat.subcategory && <p className="text-[10px] text-slate-400 mt-0.5">{mat.subcategory}</p>}
                        </div>
                        {str(mat.code) && <div className="text-[10px] text-teal-400 font-mono bg-slate-900 px-2 py-1 rounded border border-slate-700">{mat.code}</div>}
                      </div>
                    )) : <div className="p-4 text-center text-sm text-slate-400">Матеріал не знайдено. Спершу додайте його в довідник.</div>}
                  </div>
                )}
              </div>
            </div>

            {activeMaterial && <div className="p-4 bg-teal-950/20 border border-teal-900/50 rounded-xl flex items-center gap-4"><div className="w-12 h-12 bg-slate-900 rounded-lg flex items-center justify-center border border-slate-800"><Database className="text-teal-500 opacity-50" size={24} /></div><div><p className="text-white font-bold text-sm">{activeMaterial.name}</p>{activeMaterial.subcategory && <p className="text-xs text-slate-400 mt-1">{activeMaterial.subcategory}</p>}</div></div>}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="space-y-1.5 md:col-span-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">LOT Партія</label><input type="text" value={formData.lot} onChange={e => setFormData({...formData, lot: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none font-mono" placeholder="ABC-123" /></div>
              <div className="space-y-1.5 md:col-span-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Серійний № (Опц)</label><input type="text" value={formData.serial} onChange={e => setFormData({...formData, serial: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none font-mono" placeholder="SN-000" /></div>
              <div className="space-y-1.5 md:col-span-1"><label className="text-[10px] font-bold text-teal-400 uppercase tracking-widest pl-1">Розмір (Опц)</label><input type="text" value={formData.size} onChange={e => setFormData({...formData, size: e.target.value})} className="w-full bg-slate-950 border border-teal-900/50 rounded-xl p-3.5 text-teal-400 focus:ring-2 focus:ring-teal-500 outline-none font-bold" placeholder="Напр. 25, 2-0" /></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
               <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Придатний до</label><input type="date" value={formData.exp} onChange={e => setFormData({...formData, exp: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none" style={{colorScheme:'dark'}}/></div>
               <div className="space-y-1.5"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">Кількість *</label><input type="number" min="1" value={formData.quantity} onChange={e => setFormData({...formData, quantity: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-white focus:ring-2 focus:ring-teal-500 outline-none font-bold text-center text-lg" /></div>
            </div>
            <button onClick={handleSave} disabled={isSaving} className="w-full mt-6 bg-slate-800 hover:bg-teal-600 text-white font-black py-4 rounded-2xl transition-all duration-300 border border-slate-700 hover:border-teal-500 disabled:opacity-50">{isSaving ? 'Збереження...' : 'Оприбуткувати товар'}</button>
         </div>
      </div>
    </div>
  );
};

const Catalog = ({ state, dispatch, sessionPin }) => {
  const [askConfirm, confirmDialog] = useConfirm();
  const [showImport, setShowImport] = useState(false);
  const [showSubcatModal, setShowSubcatModal] = useState(false);
  const [newSubcat, setNewSubcat] = useState('');
  const [formData, setFormData] = useState({ id: '', name: '', code: '', subcategory: '', min_stock: 1 });
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingSubcat, setIsAddingSubcat] = useState(false);

  const handleSave = async () => {
    // Обов'язкова лише назва; код/артикул і підкатегорія — за бажанням.
    if (!formData.name.trim()) { alert("Вкажіть назву матеріалу."); return; }
    if (isSaving) return;
    setIsSaving(true);
    try {
      const result = await callAction('saveMaterial', formData, sessionPin);
      if (!result.success) { alert(result.error || "Помилка збереження матеріалу"); return; }

      if (isEditing) dispatch({ type: 'UPDATE_MATERIAL', payload: result.data });
      else dispatch({ type: 'ADD_MATERIAL', payload: result.data });

      setFormData({ id: '', name: '', code: '', subcategory: '', min_stock: 1 }); setIsEditing(false);
    } catch(e) { console.error(e); alert("Помилка збереження: немає з'єднання з сервером."); }
    finally { setIsSaving(false); }
  };
  const handleDelete = async (id) => {
     if(state.stock.some(s => s.material_id === id)) { alert("Неможливо видалити: матеріал має залишки на складі або історію."); return; }
     const matToDelete = state.materials.find(m => m.id === id);
     const confirmed = await askConfirm({
       title: `Видалити матеріал «${matToDelete ? matToDelete.name : ''}»?`,
       message: 'Матеріал буде видалено з довідника. Це неможливо скасувати. Дію буде записано в журнал.'
     });
     if (!confirmed) return;
     try {
       const result = await callAction('deleteMaterial', { id }, sessionPin);
       if (!result.success) { alert(result.error || "Помилка видалення"); return; }
       dispatch({ type: 'DELETE_MATERIAL', payload: id });
     } catch(e) { console.error(e); alert("Помилка видалення: немає з'єднання з сервером."); }
  };
  const handleAddSubcat = async () => {
     if(!newSubcat.trim()) return;
     if (isAddingSubcat) return;
     setIsAddingSubcat(true);
     try {
       const result = await callAction('addSubcategory', { name: newSubcat.trim() }, sessionPin);
       if (!result.success) { alert(result.error || "Помилка збереження підкатегорії"); return; }
       dispatch({type: 'ADD_SUBCATEGORY', payload: result.data});
       setNewSubcat('');
     } catch(e) { console.error(e); alert("Помилка збереження: немає з'єднання з сервером."); }
     finally { setIsAddingSubcat(false); }
  };
  const handleDeleteSubcat = async (id) => {
      const subToDelete = (state.subcategories || []).find(sc => sc.id === id);
      const confirmed = await askConfirm({
        title: `Видалити підкатегорію «${subToDelete ? subToDelete.name : ''}»?`,
        message: 'Підкатегорію буде видалено зі списку. Дію буде записано в журнал.'
      });
      if (!confirmed) return;
      try {
        const result = await callAction('deleteSubcategory', { id }, sessionPin);
        if (!result.success) { alert(result.error || "Помилка видалення підкатегорії"); return; }
        dispatch({type: 'DELETE_SUBCATEGORY', payload: id});
      } catch(e) { console.error(e); alert("Помилка видалення: немає з'єднання з сервером."); }
  };

  return (
    <div className="animate-in slide-in-from-bottom-4 duration-500 space-y-6">
      {showImport && <DocumentImportModal mode="catalog" state={state} dispatch={dispatch} sessionPin={sessionPin} onClose={() => setShowImport(false)} />}

      {showSubcatModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex justify-center items-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden p-6">
               <div className="flex justify-between items-center mb-6">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">Підкатегорії</h3>
                  <button onClick={()=>setShowSubcatModal(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
               </div>
               <div className="flex gap-2 mb-6">
                  <input type="text" value={newSubcat} onChange={e=>setNewSubcat(e.target.value)} placeholder="Нова підкатегорія..." className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none"/>
                  <button onClick={handleAddSubcat} disabled={isAddingSubcat} className="bg-teal-600 hover:bg-teal-500 text-white px-4 rounded-xl font-bold disabled:opacity-50">{isAddingSubcat ? '...' : 'Додати'}</button>
               </div>
               <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                  {(state.subcategories||[]).map(sc => (
                     <div key={sc.id} className="flex justify-between items-center bg-slate-800 p-3 rounded-xl">
                        <span className="text-sm font-bold text-white">{sc.name}</span>
                        <button onClick={()=>handleDeleteSubcat(sc.id)} className="text-rose-400 hover:text-rose-300 p-1"><Trash2 size={16}/></button>
                     </div>
                  ))}
               </div>
            </div>
         </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl h-fit">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2"><Edit2 className="text-teal-500"/> {isEditing ? 'Редагування' : 'Новий матеріал'}</h3>
          {!isEditing && <button onClick={() => setShowImport(true)} className="w-full mb-6 bg-slate-800 hover:bg-slate-700 text-teal-400 px-4 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors border border-slate-700"><Upload size={18} /> Імпорт з документа</button>}
          <div className="space-y-4">
            <div><label className="text-[10px] font-bold text-slate-400 uppercase pl-1">Назва *</label><input type="text" value={formData.name} onChange={e=>setFormData({...formData,name:e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none"/></div>
            <div><label className="text-[10px] font-bold text-slate-400 uppercase pl-1">Артикул / Код / GTIN</label><input type="text" value={formData.code} onChange={e=>setFormData({...formData,code:e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-teal-400 font-mono outline-none"/></div>
            <div>
               <label className="text-[10px] font-bold text-slate-400 uppercase flex justify-between items-center mb-1 pl-1">Підкатегорія <button onClick={() => setShowSubcatModal(true)} className="text-teal-400 hover:text-teal-300 flex items-center gap-1 bg-slate-950 px-2 py-0.5 rounded-lg border border-slate-800"><Edit2 size={10}/> Налаштувати</button></label>
               <select value={formData.subcategory} onChange={e=>setFormData({...formData,subcategory:e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none appearance-none">
                  <option value="">Без підкатегорії</option>
                  {(state.subcategories||[]).map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
               </select>
            </div>
            <div><label className="text-[10px] font-bold text-slate-400 uppercase pl-1">Мін. залишок (шт)</label><input type="number" value={formData.min_stock} onChange={e=>setFormData({...formData,min_stock:Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none font-bold text-center"/></div>
          </div>
          <button onClick={handleSave} disabled={isSaving} className="w-full mt-6 bg-teal-600 hover:bg-teal-500 text-white font-bold py-3.5 rounded-xl transition-colors disabled:opacity-50">{isSaving ? 'Збереження...' : (isEditing ? 'Оновити' : 'Зберегти')}</button>
          {isEditing && <button onClick={()=>{setIsEditing(false); setFormData({id:'',name:'',code:'',subcategory:'',min_stock:1})}} className="w-full mt-3 bg-slate-800 text-slate-300 font-bold py-3.5 rounded-xl">Скасувати</button>}
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-xl lg:col-span-2">
          <table className="w-full text-sm text-left"><thead className="text-[10px] font-bold text-slate-400 uppercase bg-slate-950"><tr><th className="px-5 py-4">Назва / Код</th><th className="px-5 py-4">Підкатегорія</th><th className="px-5 py-4 text-right">Дії</th></tr></thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300">
              {state.materials.map(mat => (
                <tr key={mat.id} className="hover:bg-slate-800/30">
                  <td className="px-5 py-4"><div className="font-bold text-white text-sm">{mat.name}</div>{str(mat.code) && <div className="text-[10px] text-teal-400 font-mono mt-1">{mat.code}</div>}</td>
                  <td className="px-5 py-4">{mat.subcategory ? <div className="text-xs font-bold text-slate-300 bg-slate-800 inline-block px-2 py-1 rounded-md border border-slate-700">{mat.subcategory}</div> : <span className="text-xs text-slate-600">—</span>}</td>
                  <td className="px-5 py-4 text-right"><button onClick={()=>{setFormData({...mat}); setIsEditing(true); window.scrollTo({top:0});}} className="p-2 text-slate-400 hover:text-teal-400 bg-slate-950 rounded-lg mr-2"><Edit2 size={16}/></button><button onClick={()=>handleDelete(mat.id)} className="p-2 text-slate-400 hover:text-rose-400 bg-slate-950 rounded-lg"><Trash2 size={16}/></button></td>
                </tr>
              ))}
            </tbody></table>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
};

const Inventory = ({ state, dispatch, isReadOnly, sessionPin }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [sortBy, setSortBy] = useState('exp_asc');
  const [writeOffModal, setWriteOffModal] = useState(null);
  const [historyModal, setHistoryModal] = useState(null);
  const [isWritingOff, setIsWritingOff] = useState(false);

  const subcategories = useMemo(() => ['All', ...Array.from(new Set(state.materials.map(m => m.subcategory || '')))].sort(), [state.materials]);

  const inventoryView = useMemo(() => {
    let result = [];
    state.materials.forEach(mat => {
      if (filterCategory !== 'All' && (mat.subcategory || '') !== filterCategory) return;
      const batches = state.stock.filter(s => s.material_id === mat.id && s.quantity > 0);
      batches.forEach(b => {
        if (str(mat.name).toLowerCase().includes(searchTerm.toLowerCase()) || str(b.lot_number).toLowerCase().includes(searchTerm.toLowerCase())) result.push({ ...mat, ...b, unique_id: b.id });
      });
    });
    return result.sort((a, b) => {
        if (sortBy === 'exp_asc') return compareExpiry(a.expiration_date, b.expiration_date, 1);
        if (sortBy === 'exp_desc') return compareExpiry(a.expiration_date, b.expiration_date, -1);
        if (sortBy === 'name_asc') return a.name.localeCompare(b.name);
        if (sortBy === 'qty_desc') return b.quantity - a.quantity;
        return 0;
    });
  }, [state, searchTerm, filterCategory, sortBy]);

  const handleWriteOff = async () => {
      if (isWritingOff) return;
      setIsWritingOff(true);
      try {
        const result = await callAction('addWriteoff', {
          stock_batch_id: writeOffModal.stock_batch_id,
          qty: writeOffModal.qty,
          reason: writeOffModal.reason
        }, sessionPin);
        if (!result.success) { alert(result.error || "Помилка списання"); return; }

        dispatch({ type: 'ADD_WRITEOFF', payload: result.data });
        setWriteOffModal(null);
      } catch(e) { console.error(e); alert("Помилка списання: немає з'єднання з сервером."); }
      finally { setIsWritingOff(false); }
  };

  const getBatchHistory = (batchId) => {
      const arrived = state.stock.find(s=>s.id === batchId) || state.writeoffs.find(w=>w.id===batchId);
      const ops = state.expenses.filter(e => e.stock_batch_id === batchId).map(e => {
         const op = state.operations.find(o => o.id === e.operation_id);
         return { type: 'operation', date: op?.operation_date || e.created_at, op_num: op?.operation_num, qty: e.quantity };
      });
      const woffs = state.writeoffs.filter(w => w.stock_batch_id === batchId).map(w => ({ type: 'writeoff', date: w.created_at, reason: w.reason, qty: w.qty }));
      return { arrived: arrived?.created_at, history: [...ops, ...woffs].sort((a,b) => new Date(b.date) - new Date(a.date)) };
  };

  const exportCSV = () => {
    let csvContent = "Дата;№ Операції;ID Пацієнта;Тип;Матеріал;Код;LOT;Серійний;Розмір;Кількість\n";
    state.operations.forEach(op => {
      const opExpenses = state.expenses.filter(e => e.operation_id === op.id);
      opExpenses.forEach(exp => {
        const batch = state.stock.find(s => s.id === exp.stock_batch_id) || state.writeoffs.find(w=>w.id===exp.stock_batch_id) || {};
        const mat = state.materials.find(m => m.id === batch.material_id) || {};
        const row = [
          op.operation_date, op.operation_num, op.patient_case_id, op.operation_type,
          mat.name || 'Невідомо', mat.code || '', batch.lot_number || '', batch.serial_number || '', batch.size || '', exp.quantity
        ].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';');
        csvContent += row + "\n";
      });
    });

    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `cardio_expenses_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">

      {writeOffModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex justify-center items-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-md shadow-2xl p-6">
               <h3 className="text-lg font-bold text-rose-400 flex items-center gap-2 mb-4"><AlertTriangle/> Інше списання (Брак)</h3>
               <p className="text-sm text-white font-bold mb-4">{writeOffModal.batch.name} <span className="text-xs text-slate-400 font-mono">LOT: {writeOffModal.batch.lot_number || '—'}</span></p>
               <div className="space-y-4 mb-6">
                  <div><label className="text-[10px] font-bold text-slate-400 uppercase">Кількість (Макс: {writeOffModal.batch.quantity})</label><input type="number" min="1" max={writeOffModal.batch.quantity} value={writeOffModal.qty} onChange={e=>setWriteOffModal({...writeOffModal, qty: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none"/></div>
                  <div><label className="text-[10px] font-bold text-slate-400 uppercase">Причина</label><select value={writeOffModal.reason} onChange={e=>setWriteOffModal({...writeOffModal, reason: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none appearance-none"><option>Прострочено</option><option>Порушення стерильності</option><option>Падіння/Брак</option></select></div>
               </div>
               <div className="flex gap-3"><button onClick={()=>setWriteOffModal(null)} className="flex-1 bg-slate-800 text-white font-bold py-3 rounded-xl">Скасувати</button><button onClick={handleWriteOff} disabled={isWritingOff} className="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded-xl disabled:opacity-50">{isWritingOff ? 'Списання...' : 'Списати'}</button></div>
            </div>
         </div>
      )}

      {historyModal && (() => {
         const hist = getBatchHistory(historyModal.unique_id);
         return (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex justify-center items-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
               <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-slate-950">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2"><Clock className="text-teal-500"/> Історія партії</h3>
                  <button onClick={()=>setHistoryModal(null)} className="text-slate-400 hover:text-white bg-slate-800 p-2 rounded-full"><X size={18}/></button>
               </div>
               <div className="p-5 overflow-y-auto flex-1 space-y-6">
                  <div>
                    <p className="font-bold text-white">{historyModal.name}</p>
                    <div className="flex gap-2 items-center mt-1">
                      {historyModal.size && <span className="text-[10px] bg-teal-900/30 text-teal-400 px-1.5 rounded font-bold">Розмір: {historyModal.size}</span>}
                      <p className="text-xs text-slate-400 font-mono">LOT: {historyModal.lot_number || '—'} | SN: {historyModal.serial_number||'-'}</p>
                    </div>
                  </div>
                  <div className="relative border-l-2 border-slate-800 ml-3 space-y-6 pl-6">
                      <div className="relative"><div className="absolute -left-[1.95rem] top-1 w-4 h-4 rounded-full bg-teal-500 border-4 border-slate-900"></div><p className="text-xs text-slate-400 mb-1">{new Date(hist.arrived).toLocaleString('uk-UA')}</p><p className="font-bold text-white text-sm">Оприбутковано на склад</p></div>
                      {hist.history.map((h, i) => (
                         <div key={i} className="relative"><div className={`absolute -left-[1.95rem] top-1 w-4 h-4 rounded-full border-4 border-slate-900 ${h.type==='operation' ? 'bg-slate-500' : 'bg-rose-500'}`}></div><p className="text-xs text-slate-400 mb-1">{new Date(h.date).toLocaleString('uk-UA')}</p><p className="font-bold text-white text-sm">{h.type === 'operation' ? `Списано на операцію №${h.op_num}` : `Списання: ${h.reason}`}</p><p className="text-xs font-black text-rose-400 mt-1">-{h.qty} шт</p></div>
                      ))}
                  </div>
               </div>
            </div>
         </div>
         );
      })()}

      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
          <input type="text" placeholder="Пошук матеріалу за назвою або партією (LOT)..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full h-full bg-slate-900 border border-slate-800 rounded-2xl py-3.5 pl-12 pr-4 text-white focus:ring-2 focus:ring-teal-500 outline-none shadow-lg placeholder:text-slate-600" />
        </div>
        <div className="flex gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-48"><Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} /><select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="w-full bg-slate-900 border border-slate-800 rounded-2xl py-3.5 pl-10 pr-3 text-sm text-white outline-none appearance-none cursor-pointer"><option value="All">Всі категорії</option>{subcategories.filter(c => c !== 'All').map(c => <option key={c || '__none'} value={c}>{c || 'Без підкатегорії'}</option>)}</select></div>
            <div className="relative flex-1 md:w-48"><ArrowDownUp className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} /><select value={sortBy} onChange={e => setSortBy(e.target.value)} className="w-full bg-slate-900 border border-slate-800 rounded-2xl py-3.5 pl-10 pr-3 text-sm text-white outline-none appearance-none cursor-pointer"><option value="exp_asc">Термін (старі)</option><option value="exp_desc">Термін (нові)</option><option value="name_asc">За алфавітом</option><option value="qty_desc">За кількістю</option></select></div>
            <button onClick={exportCSV} className="bg-slate-800 hover:bg-slate-700 text-teal-400 border border-slate-700 rounded-2xl px-4 flex items-center justify-center transition-colors" title="Експорт витрат у CSV"><Download size={20}/></button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left"><thead className="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-950"><tr><th className="px-5 py-4">Номенклатура</th><th className="px-5 py-4">Партія (LOT / SN)</th><th className="px-5 py-4">Термін</th><th className="px-5 py-4 text-right">Залишок</th></tr></thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300">
              {inventoryView.map(item => {
                const isExpiring = !!item.expiration_date && new Date(item.expiration_date) <= new Date(new Date().setDate(new Date().getDate() + 30));
                return (
                  <tr key={item.unique_id} onClick={()=>setHistoryModal(item)} className="hover:bg-slate-800/30 transition-colors cursor-pointer group">
                    <td className="px-5 py-4"><div className="font-bold text-white text-sm">{item.name}</div>{str(item.code) && <div className="text-[10px] text-slate-500 font-mono mt-1">{item.code}</div>}</td>
                    <td className="px-5 py-4 font-mono text-xs">
                       {item.lot_number ? <div className="text-teal-400 font-bold bg-teal-500/10 inline-block px-2 py-0.5 rounded border border-teal-500/20">{item.lot_number}</div> : <span className="text-slate-600">без LOT</span>}
                       {item.size && <div className="text-[13px] font-bold text-white mt-1 bg-slate-800 px-2 py-0.5 rounded-md inline-block border border-slate-700 shadow-sm">Розмір: <span className="text-teal-400">{item.size}</span></div>}
                       {item.serial_number && <div className="text-slate-400 mt-1.5">SN: {item.serial_number}</div>}
                    </td>
                    <td className="px-5 py-4"><span className={`px-2.5 py-1 rounded-md text-xs font-bold inline-flex items-center gap-1 ${isExpiring ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'text-slate-400'}`}>{isExpiring && <AlertTriangle size={12} />}{fmtDateUk(item.expiration_date)}</span></td>
                    <td className="px-5 py-4 text-right">
                       <div className="flex items-center justify-end gap-3">
                          <div className="font-black text-xl text-white">{item.quantity} <span className="text-xs text-slate-500 font-medium">шт</span></div>
                          {!isReadOnly && <button onClick={(e) => { e.stopPropagation(); setWriteOffModal({batch: item, qty: 1, reason: 'Прострочено', stock_batch_id: item.unique_id}); }} className="p-2 bg-rose-950 text-rose-400 hover:text-white hover:bg-rose-900 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity"><AlertTriangle size={16}/></button>}
                       </div>
                    </td>
                  </tr>
                )
              })}
              {inventoryView.length === 0 && <tr><td colSpan="4" className="px-5 py-16 text-center"><Database size={48} className="mx-auto text-slate-700 mb-3" /><p className="text-slate-500 font-medium">Склад порожній або нічого не знайдено</p></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const UsersManager = ({ state, dispatch, sessionPin, currentUser, onSelfUpdated }) => {
  const [askConfirm, confirmDialog] = useConfirm();
  const [formData, setFormData] = useState({ id: '', name: '', pin: '', role: 'user', permissions: ['inventory'] });
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const availablePermissions = [
    { id: 'dashboard', label: 'Дашборд (Аналітика)' },
    { id: 'postop', label: 'Списання на операцію' },
    { id: 'stockin', label: 'Прихід товару' },
    { id: 'catalog', label: 'Редагування довідника' }
  ];

  const handleTogglePermission = (permId) => {
    if (formData.permissions.includes(permId)) {
      setFormData({ ...formData, permissions: formData.permissions.filter(p => p !== permId) });
    } else {
      setFormData({ ...formData, permissions: [...formData.permissions, permId] });
    }
  };

  const handleSave = async () => {
    if (!formData.name || formData.pin.length < 4) { alert("Введіть ім'я та ПІН-код (мінімум 4 цифри)"); return; }
    if (state.users.some(u => u.pin === formData.pin && u.id !== formData.id)) { alert("Цей ПІН-код вже використовується!"); return; }
    if (isSaving) return;

    setIsSaving(true);
    try {
      const result = await callAction('saveUser', formData, sessionPin);
      if (!result.success) { alert(result.error || "Помилка збереження користувача"); return; }
      if (isEditing) dispatch({ type: 'UPDATE_USER', payload: result.data });
      else dispatch({ type: 'ADD_USER', payload: result.data });
      // Адмін змінив власний запис (PIN чи ім'я): оновлюємо сесію, інакше наступні запити
      // підуть зі старим PIN і сервер їх відхилить.
      if (isEditing && currentUser && result.data.id === currentUser.id && onSelfUpdated) onSelfUpdated(result.data);

      setFormData({ id: '', name: '', pin: '', role: 'user', permissions: ['inventory'] });
      setIsEditing(false);
    } catch(e) { console.error(e); alert("Помилка збереження: немає з'єднання з сервером."); }
    finally { setIsSaving(false); }
  };

  const handleDelete = async (id) => {
    const userToDelete = state.users.find(u => u.id === id);
    const confirmed = await askConfirm({
      title: `Видалити користувача «${userToDelete ? userToDelete.name : ''}»?`,
      message: 'Користувач одразу втратить доступ. Дію буде записано в журнал.'
    });
    if (!confirmed) return;
    try {
      const result = await callAction('deleteUser', { id }, sessionPin);
      if (!result.success) { alert(result.error || "Помилка видалення користувача"); return; }
      dispatch({ type: 'DELETE_USER', payload: id });
    } catch(e) { console.error(e); alert("Помилка видалення: немає з'єднання з сервером."); }
  };

  return (
    <div className="animate-in slide-in-from-bottom-4 duration-500 space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl h-fit">
          <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2"><Shield className="text-teal-500"/> {isEditing ? 'Редагування доступу' : 'Новий працівник'}</h3>
          <div className="space-y-4">
            <div>
               <label className="text-[10px] font-bold text-slate-400 uppercase pl-1">Ім'я / Посада *</label>
               <input type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white outline-none" placeholder="Медсестра Анна" />
            </div>
            <div>
               <label className="text-[10px] font-bold text-slate-400 uppercase pl-1">PIN-код (4–6 цифр) *</label>
               <input type="text" maxLength="6" value={formData.pin} onChange={e => setFormData({...formData, pin: e.target.value.replace(/\D/g, '')})} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-teal-400 font-mono text-lg tracking-widest text-center outline-none" placeholder="****" />
            </div>

            {formData.role !== 'admin' && (
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <p className="text-[10px] font-bold text-slate-400 uppercase mb-3">Права доступу (вкладки)</p>
                <div className="space-y-2">
                  {availablePermissions.map(perm => (
                    <label key={perm.id} className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={formData.permissions.includes(perm.id)} onChange={() => handleTogglePermission(perm.id)} className="w-4 h-4 accent-teal-500" />
                      <span className="text-sm text-slate-300 font-medium">{perm.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button onClick={handleSave} disabled={isSaving} className="w-full mt-6 bg-teal-600 hover:bg-teal-500 text-white font-bold py-3.5 rounded-xl transition-colors disabled:opacity-50">{isSaving ? 'Збереження...' : (isEditing ? 'Оновити' : 'Створити ПІН')}</button>
          {isEditing && <button onClick={() => {setIsEditing(false); setFormData({id:'',name:'',pin:'',role:'user',permissions:['inventory']})}} className="w-full mt-3 bg-slate-800 text-slate-300 font-bold py-3.5 rounded-xl">Скасувати</button>}
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-xl lg:col-span-2">
          <table className="w-full text-sm text-left">
            <thead className="text-[10px] font-bold text-slate-400 uppercase bg-slate-950">
              <tr><th className="px-5 py-4">Користувач</th><th className="px-5 py-4">ПІН</th><th className="px-5 py-4">Доступ</th><th className="px-5 py-4 text-right">Дії</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300">
              {state.users?.map(u => (
                <tr key={u.id} className="hover:bg-slate-800/30">
                  <td className="px-5 py-4">
                    <div className="font-bold text-white text-sm">{u.name}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{u.role === 'admin' ? 'Адміністратор' : 'Персонал'}</div>
                  </td>
                  <td className="px-5 py-4"><span className="font-mono text-teal-400 bg-teal-500/10 px-2 py-1 rounded border border-teal-500/20">{u.pin}</span></td>
                  <td className="px-5 py-4">
                    {u.role === 'admin' ? <span className="text-xs text-rose-400 font-bold">Повний доступ</span> :
                    <div className="flex flex-wrap gap-1">
                      {u.permissions.map(p => <span key={p} className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">{availablePermissions.find(a=>a.id===p)?.label || p}</span>)}
                    </div>}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button onClick={() => {setFormData({...u}); setIsEditing(true);}} className="p-2 text-slate-400 hover:text-teal-400 bg-slate-950 rounded-lg mr-2"><Edit2 size={16}/></button>
                    {u.role !== 'admin' && <button onClick={() => handleDelete(u.id)} className="p-2 text-slate-400 hover:text-rose-400 bg-slate-950 rounded-lg"><Trash2 size={16}/></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
};

// Reducer — чиста функція над локальним станом; персистентність робить Apps Script + Google Sheets
// ---------- Журнал дій (лише для адміністратора) ----------
// Дані віддає Code.gs (handleGetAudit_): найновіші записи першими. Пошук і фільтри — на боці клієнта по
// завантажених записах, щоб кожен символ пошуку не ходив на сервер (кожен запит до Apps Script повільний
// і входить у спільний ліміт 20 PIN-перевірок на хвилину).
const AUDIT_PAGE_SIZE = 500;
const AUDIT_MAX_LIMIT = 2000; // збігається з обмеженням на сервері

const AUDIT_TONES = {
  teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  rose: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  slate: 'bg-slate-800 text-slate-300 border-slate-700'
};

// Назва, колір і належність до фільтрів для кожної дії, яку пише Code.gs (logAudit_).
const AUDIT_ACTIONS = {
  addStock:          { label: 'Прихід',                 tone: 'teal',   groups: ['stock'] },
  addStockBatch:     { label: 'Прихід з документа',     tone: 'teal',   groups: ['stock'] },
  addMaterialsBatch: { label: 'Довідник з документа',   tone: 'teal',   groups: [] },
  addOperation:      { label: 'Списання на операцію',   tone: 'teal',   groups: ['stock'] },
  addWriteoff:       { label: 'Списання зі складу',     tone: 'amber',  groups: ['stock'] },
  deleteOperation:   { label: 'Видалення операції',     tone: 'rose',   groups: ['delete', 'stock'] },
  deleteMaterial:    { label: 'Видалення матеріалу',    tone: 'rose',   groups: ['delete'] },
  deleteSubcategory: { label: 'Видалення підкатегорії', tone: 'rose',   groups: ['delete'] },
  deleteTemplate:    { label: 'Видалення шаблону',      tone: 'rose',   groups: ['delete'] },
  saveUser:          { label: 'Зміна користувача',      tone: 'violet', groups: ['users'] },
  deleteUser:        { label: 'Видалення користувача',  tone: 'rose',   groups: ['delete', 'users'] }
};

const AUDIT_FILTERS = [
  { id: 'all', label: 'Усі дії' },
  { id: 'delete', label: 'Видалення' },
  { id: 'stock', label: 'Рух складу' },
  { id: 'users', label: 'Користувачі' }
];

// "2026-10-13 09:15:02" -> "13.10.2026 09:15:02"
const formatAuditTime = (ts) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(str(ts));
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : str(ts);
};

const AuditLogViewer = ({ sessionPin }) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(AUDIT_PAGE_SIZE);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const requestId = useRef(0);

  const load = useCallback(async (wantedLimit) => {
    const myId = ++requestId.current;
    setIsLoading(true);
    setError('');
    try {
      const result = await callAction('getAudit', { limit: wantedLimit }, sessionPin);
      if (myId !== requestId.current) return; // прийшла застаріла відповідь — ігноруємо
      if (!result.success) { setError(result.error || 'Не вдалося завантажити журнал.'); return; }
      setRows(result.data.rows || []);
      setTotal(result.data.total || 0);
      setLimit(wantedLimit);
    } catch (e) {
      if (myId !== requestId.current) return;
      console.error(e);
      setError(e.message || "Немає з'єднання з сервером.");
    } finally {
      if (myId === requestId.current) setIsLoading(false);
    }
  }, [sessionPin]);

  useEffect(() => { load(AUDIT_PAGE_SIZE); }, [load]);

  const filtered = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const info = AUDIT_ACTIONS[r.action];
      if (filter !== 'all' && !(info && info.groups.includes(filter))) return false;
      if (terms.length === 0) return true;
      // Усі слова пошуку мають зустрітися (в будь-якому порядку): "оля 0042" знайде дії Олі з операцією 0042.
      const haystack = `${formatAuditTime(r.timestamp)} ${str(r.timestamp)} ${str(r.user_name)} ${info ? info.label : str(r.action)} ${str(r.details)}`.toLowerCase();
      return terms.every(t => haystack.includes(t));
    });
  }, [rows, search, filter]);

  const hasMoreOnServer = rows.length < total;
  const canLoadMore = hasMoreOnServer && limit < AUDIT_MAX_LIMIT;
  const olderOnlyInSheet = hasMoreOnServer && limit >= AUDIT_MAX_LIMIT;

  return (
    <div className="animate-in slide-in-from-bottom-4 duration-500 space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 md:p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2"><ClipboardList className="text-teal-500" /> Журнал дій</h3>
            <p className="text-xs text-slate-500 mt-1">Хто, коли і що змінив у системі. Найновіші записи — зверху.</p>
          </div>
          <button onClick={() => load(limit)} disabled={isLoading} aria-label="Оновити журнал" className="shrink-0 p-2.5 bg-slate-950 border border-slate-800 text-slate-400 hover:text-teal-400 rounded-xl disabled:opacity-50 transition-colors">
            <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук: людина, № операції, ІБ, матеріал, LOT..." className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 pl-10 pr-3 text-white outline-none text-sm" />
          </div>
          <div className="flex gap-2 flex-wrap">
            {AUDIT_FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} className={`px-3.5 py-2.5 rounded-xl text-xs font-bold border transition-colors ${filter === f.id ? 'bg-teal-500/10 text-teal-400 border-teal-500/30' : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'}`}>{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-rose-950/30 border border-rose-900/50 rounded-3xl p-5 flex items-center justify-between gap-3" role="alert">
          <div className="flex items-center gap-3 text-rose-400 text-sm font-medium"><AlertTriangle size={18} className="shrink-0" /> {error}</div>
          <button onClick={() => load(limit)} className="shrink-0 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-xl">Повторити</button>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-3xl shadow-xl overflow-hidden">
        <div className="hidden md:grid md:grid-cols-[150px_170px_210px_1fr] gap-4 px-5 py-3 bg-slate-950 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          <div>Час</div><div>Хто</div><div>Дія</div><div>Деталі</div>
        </div>
        {isLoading && rows.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm font-medium">Завантаження журналу...</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm font-medium">
            {rows.length === 0 && !error ? 'Журнал поки порожній.' : (rows.length === 0 ? '' : 'Нічого не знайдено за цими умовами.')}
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {filtered.map(r => {
              const info = AUDIT_ACTIONS[r.action];
              return (
                <div key={r.id} className="px-5 py-3.5 md:grid md:grid-cols-[150px_170px_210px_1fr] md:gap-4 md:items-start hover:bg-slate-800/30 transition-colors">
                  <div className="text-[11px] text-slate-500 font-mono">{formatAuditTime(r.timestamp)}</div>
                  <div className="text-sm font-bold text-white mt-0.5 md:mt-0">{str(r.user_name) || '—'}</div>
                  <div className="mt-1.5 md:mt-0">
                    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md border ${AUDIT_TONES[info ? info.tone : 'slate']}`}>{info ? info.label : str(r.action)}</span>
                  </div>
                  <div className="text-sm text-slate-300 break-words mt-1.5 md:mt-0">{str(r.details)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-1">
        <p className="text-xs text-slate-500">
          Показано <span className="text-slate-300 font-bold">{filtered.length}</span> із {rows.length} завантажених · усього в журналі: {total}
        </p>
        {canLoadMore && (
          <button onClick={() => load(Math.min(limit + AUDIT_PAGE_SIZE, AUDIT_MAX_LIMIT))} disabled={isLoading} className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-5 py-2.5 rounded-xl disabled:opacity-50">Завантажити ще</button>
        )}
        {olderOnlyInSheet && (
          <p className="text-xs text-slate-500">Старіші записи доступні в листі AuditLog у Google Таблиці.</p>
        )}
      </div>
    </div>
  );
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'INIT': return action.payload;
    case 'ADD_STOCK': return { ...state, stock: [...state.stock, action.payload] };
    case 'ADD_MATERIAL': return { ...state, materials: [...state.materials, action.payload] };
    case 'UPDATE_MATERIAL': return { ...state, materials: state.materials.map(m => m.id === action.payload.id ? action.payload : m) };
    case 'DELETE_MATERIAL': return { ...state, materials: state.materials.filter(m => m.id !== action.payload) };
    case 'ADD_SUBCATEGORY': return { ...state, subcategories: [...(state.subcategories||[]), action.payload] };
    case 'DELETE_SUBCATEGORY': return { ...state, subcategories: state.subcategories.filter(s => s.id !== action.payload) };
    case 'ADD_USER': return { ...state, users: [...state.users, action.payload] };
    case 'UPDATE_USER': return { ...state, users: state.users.map(u => u.id === action.payload.id ? action.payload : u) };
    case 'DELETE_USER': return { ...state, users: state.users.filter(u => u.id !== action.payload) };
    case 'ADD_TEMPLATE':
      return { ...state, templates: [...(state.templates||[]), action.payload.template], templateItems: [...(state.templateItems||[]), ...action.payload.items] };
    case 'UPDATE_TEMPLATE': {
      const { template, items } = action.payload;
      return {
        ...state,
        templates: state.templates.map(t => t.id === template.id ? template : t),
        templateItems: [...state.templateItems.filter(ti => ti.template_id !== template.id), ...items]
      };
    }
    case 'DELETE_TEMPLATE':
      return {
        ...state,
        templates: state.templates.filter(t => t.id !== action.payload),
        templateItems: state.templateItems.filter(ti => ti.template_id !== action.payload)
      };
    case 'ADD_WRITEOFF':
      return {
        ...state,
        writeoffs: [...state.writeoffs, action.payload],
        stock: state.stock.map(b => b.id === action.payload.stock_batch_id ? {...b, quantity: b.quantity - action.payload.qty} : b)
      };
    case 'ADD_OPERATION': {
      const { operation, expenses } = action.payload;
      const updatedStock = state.stock.map(batch => {
         const used = expenses.find(e => e.stock_batch_id === batch.id);
         return used ? { ...batch, quantity: batch.quantity - used.quantity } : batch;
      });
      return { ...state, operations: [...state.operations, operation], expenses: [...state.expenses, ...expenses], stock: updatedStock };
    }
    case 'DELETE_OPERATION': {
      const opId = action.payload;
      const expsToRestore = state.expenses.filter(e => e.operation_id === opId);
      const restoredStock = state.stock.map(batch => {
         const rest = expsToRestore.find(e => e.stock_batch_id === batch.id);
         return rest ? { ...batch, quantity: batch.quantity + rest.quantity } : batch;
      });
      return {
        ...state,
        operations: state.operations.filter(o => o.id !== opId),
        expenses: state.expenses.filter(e => e.operation_id !== opId),
        stock: restoredStock
      };
    }
    default: return state;
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('inventory');
  const [isLocked, setIsLocked] = useState(true);
  const [showAuth, setShowAuth] = useState(false);
  const [pin, setPin] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [sessionPin, setSessionPin] = useState('');

  const [state, dispatch] = React.useReducer(reducer, { materials: [], stock: [], operations: [], expenses: [], subcategories: [], writeoffs: [], users: [], templates: [], templateItems: [] });
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [isCheckingPin, setIsCheckingPin] = useState(false);
  const [pinError, setPinError] = useState('');

  const loadData = async (pinForAuth) => {
    const data = normalizeData(await fetchAllData(pinForAuth));
    dispatch({
      type: 'INIT',
      payload: {
        ...data,
        subcategories: data.subcategories.length > 0 ? data.subcategories : DEFAULT_SUBCATEGORIES
      }
    });
  };

  useEffect(() => {
    (async () => {
      try {
        await loadData();
        setIsLoaded(true);
      } catch (error) {
        console.error("Помилка завантаження даних:", error);
        setLoadError(error.message || "Невідома помилка з'єднання з Apps Script.");
      }
    })();
  }, []);

  // Завершення сесії, коли сервер каже, що PIN більше недійсний (його змінив адмін / обліковий запис видалено).
  useEffect(() => {
    sessionInvalidHandler = () => {
      setIsLocked(true); setCurrentUser(null); setSessionPin(''); setActiveTab('inventory');
      setPin('');
      setPinError('Сесію завершено: ваш PIN змінено або обліковий запис видалено. Увійдіть знову.');
      setShowAuth(true);
      loadData().catch(e => console.error("Не вдалося оновити дані після завершення сесії:", e));
    };
    return () => { sessionInvalidHandler = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Адмін змінив власний запис: оновлюємо PIN сесії та дані користувача (інакше всі наступні запити впадуть).
  const handleSelfUpdated = (u) => {
    setSessionPin(u.pin);
    setCurrentUser({ id: u.id, name: u.name, role: u.role, permissions: u.permissions || [] });
  };

  // Перевірка PIN на сервері (Code.gs). PIN може мати 4–6 цифр, тому автоматично він
  // відправляється лише на 6-й цифрі; для коротших — кнопка OK.
  const submitPin = async (pinValue) => {
     if (pinValue.length < PIN_MIN_LENGTH || isCheckingPin) return;

     setIsCheckingPin(true);
     setPinError('');
     try {
       // Звірка PIN тепер на сервері (Code.gs) — сюди більше не тягнемо повний
       // список PIN-кодів наперед, лише результат "хто це і які права".
       const result = await callAction('login', {}, pinValue);
       if (result.success) {
         const foundUser = result.data;
         setCurrentUser(foundUser);
         setSessionPin(pinValue);
         setIsLocked(false);
         setShowAuth(false);
         setPin('');
         if (foundUser.role === 'admin') setActiveTab('dashboard');
         else setActiveTab(foundUser.permissions.includes('postop') ? 'postop' : 'inventory');
         // Довантажуємо повніший зріз даних тепер, коли PIN підтверджено сервером
         // (ІБ пацієнтів для будь-кого залогіненого; реальні PIN-и — лише для admin).
         loadData(pinValue).catch(e => console.error("Не вдалося довантажити дані після входу:", e));
       } else {
         setPinError(result.error || 'Невірний PIN-код.');
         setPin('');
       }
     } catch (e) {
       console.error("Помилка перевірки PIN:", e);
       setPinError(e.message || "Немає з'єднання з сервером.");
       setPin('');
     } finally {
       setIsCheckingPin(false);
     }
  };

  const handlePinDigit = (digit) => {
     if (isCheckingPin || pin.length >= PIN_MAX_LENGTH) return;
     const newPin = pin + digit;
     setPin(newPin);
     setPinError('');
     if (newPin.length === PIN_MAX_LENGTH) submitPin(newPin);
  };

  const handlePinBackspace = () => {
     if (isCheckingPin) return;
     setPin(prev => prev.slice(0, -1));
     setPinError('');
  };

  const closeAuth = () => { setShowAuth(false); setPin(''); setPinError(''); };

  const hasAccess = (tabId) => {
     if (!currentUser) return false;
     if (currentUser.role === 'admin') return true;
     if (tabId === 'inventory') return true;
     return currentUser.permissions.includes(tabId);
  };

  // Без входу доступна лише вкладка "Склад". Обчислюємо її тут, а не оновлюємо стан під час
  // рендеру (як було раніше): у JSX більше немає побічних ефектів.
  const currentTab = (isLocked && activeTab !== 'inventory') ? 'inventory' : activeTab;

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#020817] flex flex-col items-center justify-center gap-4 text-rose-400 p-6 text-center">
        <AlertTriangle size={48} />
        <p className="font-bold">Не вдалося завантажити дані.</p>
        <p className="text-sm text-slate-400 max-w-md">{loadError}</p>
        <p className="text-xs text-slate-500 max-w-md">Перевірте URL Apps Script у appsScriptClient.js та налаштування деплою (Execute as: Me, Who has access: Anyone).</p>
      </div>
    );
  }

  if (!isLoaded) return (
    <div className="min-h-screen bg-[#020817] flex flex-col items-center justify-center gap-4">
      <HeartPulse size={48} className="animate-pulse text-teal-500" />
      <span className="text-slate-500 text-xs font-bold uppercase tracking-widest">З'єднання з базою...</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#020817] text-slate-200 pb-24 md:pb-0 font-sans">

      {showAuth && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex justify-center items-center p-4">
           <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl flex flex-col items-center animate-in zoom-in-95 duration-200">
              <div className="w-16 h-16 bg-slate-800 rounded-2xl flex items-center justify-center mb-6 border border-slate-700 shadow-inner"><Lock size={32} className="text-teal-500"/></div>
              <h2 className="text-xl font-bold text-white mb-6">{isCheckingPin ? 'Перевірка...' : 'Введіть PIN-код'}</h2>
              <div className="flex gap-3 mb-3">
                {Array.from({ length: PIN_MAX_LENGTH }, (_, i) => i).map(i => <div key={i} className={`w-4 h-4 rounded-full transition-all ${pin.length > i ? 'bg-teal-500 scale-110 shadow-[0_0_10px_rgba(20,184,166,0.5)]' : 'bg-slate-800'}`}></div>)}
              </div>
              <p className="text-[11px] text-slate-500 mb-5">4–6 цифр, потім натисніть OK</p>
              {pinError && <p className="text-sm text-rose-400 font-medium mb-5 text-center" role="alert">{pinError}</p>}
              <div className="grid grid-cols-3 gap-4 w-full mb-6">
                 {[1,2,3,4,5,6,7,8,9].map(num => <button key={num} disabled={isCheckingPin} onClick={()=>handlePinDigit(num.toString())} className="h-16 bg-slate-800 hover:bg-slate-700 rounded-2xl text-2xl font-bold text-white transition-colors shadow-sm disabled:opacity-40">{num}</button>)}
                 <button disabled={isCheckingPin || pin.length === 0} onClick={handlePinBackspace} aria-label="Стерти останню цифру" className="h-16 bg-slate-800 hover:bg-slate-700 rounded-2xl text-2xl font-bold text-slate-300 transition-colors shadow-sm disabled:opacity-40">⌫</button>
                 <button disabled={isCheckingPin} onClick={()=>handlePinDigit('0')} className="h-16 bg-slate-800 hover:bg-slate-700 rounded-2xl text-2xl font-bold text-white transition-colors shadow-sm disabled:opacity-40">0</button>
                 <button disabled={isCheckingPin || pin.length < PIN_MIN_LENGTH} onClick={()=>submitPin(pin)} className="h-16 bg-teal-600 hover:bg-teal-500 rounded-2xl text-xl font-black text-white transition-colors shadow-sm disabled:opacity-30 disabled:hover:bg-teal-600">OK</button>
              </div>
              <button onClick={closeAuth} className="text-slate-500 hover:text-white text-sm font-bold">Скасувати</button>
           </div>
        </div>
      )}

      <header className="bg-slate-950/80 backdrop-blur-xl border-b border-slate-800/50 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 md:px-8 h-16 md:h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="bg-gradient-to-br from-teal-400 to-emerald-600 text-slate-950 p-2 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)]"><HeartPulse size={24} strokeWidth={2.5} /></div>
             <div><h1 className="text-xl font-black tracking-tight text-white leading-none">Cardio<span className="text-teal-400">Stock</span></h1><span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">Хірургічний облік</span></div>
          </div>
          <div className="flex items-center gap-4">
             {!isLocked && (
               <div className="hidden md:flex items-center gap-1 bg-slate-900/50 p-1.5 rounded-2xl border border-slate-800">
                  {[{id: 'dashboard', label: 'Дашборд'},{id: 'postop', label: 'Списання'},{id: 'stockin', label: 'Прихід'},{id: 'inventory', label: 'Склад'},{id: 'catalog', label: 'Довідник'}].map(t => (
                    hasAccess(t.id) && (
                      <button key={t.id} onClick={() => setActiveTab(t.id)} className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 ${activeTab === t.id ? 'bg-slate-800 text-teal-400 shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}>{t.label}</button>
                    )
                  ))}
                  {currentUser?.role === 'admin' && (
                     <button onClick={() => setActiveTab('users')} className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 ${activeTab === 'users' ? 'bg-teal-900/30 text-teal-400 border border-teal-500/30 shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}><Users size={16}/></button>
                  )}
                  {currentUser?.role === 'admin' && (
                     <button onClick={() => setActiveTab('audit')} aria-label="Журнал дій" title="Журнал дій" className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 ${activeTab === 'audit' ? 'bg-teal-900/30 text-teal-400 border border-teal-500/30 shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}><ClipboardList size={16}/></button>
                  )}
               </div>
             )}
             <button onClick={()=>{
                 if(!isLocked) {
                   setIsLocked(true); setCurrentUser(null); setSessionPin(''); setActiveTab('inventory');
                   loadData().catch(e => console.error("Не вдалося оновити дані після виходу:", e));
                 }
                 else { setShowAuth(true); }
             }} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition-colors border ${isLocked ? 'bg-teal-500/10 text-teal-400 border-teal-500/20 hover:bg-teal-500/20' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'}`}>
                {isLocked ? <><Lock size={16}/> Увійти</> : <><Unlock size={16}/> {currentUser?.name.split(' ')[0]}</>}
             </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-6 md:py-10">
        <ErrorBoundary resetKey={currentTab}>
          {currentTab === 'dashboard' && hasAccess('dashboard') && <Dashboard state={state} dispatch={dispatch} sessionPin={sessionPin} />}
          {currentTab === 'postop' && hasAccess('postop') && <PostOpExpense state={state} dispatch={dispatch} sessionPin={sessionPin} />}
          {currentTab === 'stockin' && hasAccess('stockin') && <StockIn state={state} dispatch={dispatch} sessionPin={sessionPin} />}
          {currentTab === 'catalog' && hasAccess('catalog') && <Catalog state={state} dispatch={dispatch} sessionPin={sessionPin} />}
          {currentTab === 'inventory' && <Inventory state={state} dispatch={dispatch} isReadOnly={isLocked} sessionPin={sessionPin} />}
          {currentTab === 'users' && currentUser?.role === 'admin' && <UsersManager state={state} dispatch={dispatch} sessionPin={sessionPin} currentUser={currentUser} onSelfUpdated={handleSelfUpdated} />}
          {currentTab === 'audit' && currentUser?.role === 'admin' && <AuditLogViewer sessionPin={sessionPin} />}
        </ErrorBoundary>
      </main>

      {!isLocked && (
        <nav className="md:hidden fixed bottom-0 w-full bg-slate-950/90 backdrop-blur-lg border-t border-slate-800 pb-safe z-40">
          <div className="flex justify-around items-center h-20 px-2">
            {hasAccess('dashboard') && <button onClick={() => setActiveTab('dashboard')} aria-label="Дашборд" className={`flex flex-col items-center gap-1.5 ${activeTab==='dashboard'?'text-teal-400':'text-slate-500'}`}><Activity size={22}/></button>}
            {hasAccess('stockin') && <button onClick={() => setActiveTab('stockin')} aria-label="Прихід" className={`flex flex-col items-center gap-1.5 ${activeTab==='stockin'?'text-teal-400':'text-slate-500'}`}><PackagePlus size={22}/></button>}

            {hasAccess('postop') && (
               <div className="relative -top-6"><button onClick={() => setActiveTab('postop')} aria-label="Списання на операцію" className={`h-16 w-16 rounded-full flex items-center justify-center shadow-lg border-4 border-[#020817] ${activeTab==='postop'?'bg-teal-400 text-slate-950':'bg-slate-800 text-teal-400'}`}><HeartPulse size={28} strokeWidth={2.5}/></button></div>
            )}

            <button onClick={() => setActiveTab('inventory')} aria-label="Склад" className={`flex flex-col items-center gap-1.5 ${activeTab==='inventory'?'text-teal-400':'text-slate-500'}`}><Database size={22}/></button>
            {hasAccess('catalog') && <button onClick={() => setActiveTab('catalog')} aria-label="Довідник" className={`flex flex-col items-center gap-1.5 ${activeTab==='catalog'?'text-teal-400':'text-slate-500'}`}><Edit2 size={22}/></button>}
            {currentUser?.role === 'admin' && <button onClick={() => setActiveTab('users')} aria-label="Користувачі" className={`flex flex-col items-center gap-1.5 ${activeTab==='users'?'text-teal-400':'text-slate-500'}`}><Users size={22}/></button>}
            {currentUser?.role === 'admin' && <button onClick={() => setActiveTab('audit')} aria-label="Журнал дій" className={`flex flex-col items-center gap-1.5 ${activeTab==='audit'?'text-teal-400':'text-slate-500'}`}><ClipboardList size={22}/></button>}
          </div>
        </nav>
      )}
    </div>
  );
}
