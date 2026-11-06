const keys = ['intro', 'host', 'unsupported', 'failed', 'progress', 'count', 'cancel', 'state.running', 'state.completed', 'state.partial', 'state.cancelled', 'state.interrupted', 'partialRegistration', 'review', 'losses', 'sessions', 'merge', 'settings', 'parentDetached', 'scoped', 'setting.create', 'setting.conflict', 'setting.unchanged', 'keep', 'copy', 'replace', 'content', 'readOnly', 'confirm', 'sources', 'sourcePath', 'automatic', 'scanning', 'scan', 'scanErrors', 'empty', 'selectNone', 'selectAll', 'options', 'commonTarget', 'mergeHint', 'preview'] as const;
type ImportMessages = Record<`historyImport.${typeof keys[number]}`, string> & { 'tour.import': string };
function messages(title: string, values: string[]): ImportMessages {
  if (values.length !== keys.length) throw new Error('Incomplete history import translations');
  return { 'tour.import': title, ...Object.fromEntries(keys.map((key, index) => [`historyImport.${key}`, values[index]])) } as ImportMessages;
}
const historyImportBaseMessages = {
  en: messages('Import history', [
    'Bring conversations and project rules from other agents into Yuri.', 'Reads the connected Host, not this browser or phone. Originals stay unchanged.',
    'Update Yuri and OpenCode on this Host to enable import.', 'Operation failed. Successful results are kept; check the error and retry.',
    'Import progress', '{done} of {total} processed', 'Stop after current item', 'Importing', 'Completed', 'Partially completed', 'Cancelled', 'Interrupted', 'Project registration or index refresh needs retry',
    'Review import', 'Tool calls/results are archived as text, not replayed. Available reasoning is retained; missing attachments and runtime state cannot be restored. Historical usage is unknown.',
    'Conversations', 'Combine into a new conversation', 'Import project rules and skills', 'Children without a selected parent will become independent conversations.',
    'Conditional scope is retained as text. Review applicability before enabling.', 'Create file', 'Existing file differs', 'Already present — skip', 'Keep existing', 'Keep both', 'Replace with backup', 'View contents',
    'Only selected conversations are imported; existing files are kept on conflict. Skills copy SKILL.md only, without supporting scripts or resources. Credentials, permissions, hooks, MCP commands and plugins are not copied or executed.', 'Confirm import', 'Sources', 'Custom source path', 'Optional: leave empty to find standard folders on this Host.',
    'Scanning…', 'Find conversations', '{count} sources or files could not be read', 'No conversation preview available.', 'Deselect all', 'Select all', 'Import options', 'One project path for all selections',
    'Creates a new conversation in list order, removing only an identical shared prefix. Originals stay unchanged. All selections must map to one project.', 'Preview selections',
  ]),
  'zh-CN': messages('导入历史', [
    '把其他 Agent 的历史对话和项目规则带进 Yuri。', '读取当前连接主机，不扫描浏览器或手机；原数据保持不变。',
    '请更新当前主机的 Yuri 和 OpenCode 后使用导入。', '操作未完成，成功结果会保留；请检查错误后重试。',
    '导入进度', '已处理 {done} / {total}', '完成当前项后停止', '正在导入', '已完成', '部分完成', '已取消', '已中断', '项目登记或索引刷新需要重试',
    '确认导入内容', '工具调用与结果作为历史文本保留，不会重放。保留可用的思考文本；缺失附件与原运行状态无法恢复，历史用量标为未知。',
    '历史对话', '合并为一个新对话', '导入项目规则与技能', '未选中父对话的子对话将作为独立对话导入。',
    '条件作用范围以原文保留，启用前请检查适用条件。', '新建文件', '已有文件内容不同', '已存在，将跳过', '保留现有', '两份并存', '备份后替换', '查看内容',
    '仅导入所选对话；文件冲突时保留现有内容。技能仅复制 SKILL.md，不包含配套脚本与资源。不复制或执行凭据、权限、hooks、MCP 命令和插件。', '确认导入', '数据来源', '自定义来源路径', '可留空，自动查找当前主机上的标准目录。',
    '正在扫描…', '查找历史对话', '{count} 个来源或文件读取失败', '暂无可预览的对话。', '取消全选', '全选', '导入选项', '统一导入到一个项目路径',
    '按列表顺序生成新对话，只去除完全相同的公共前缀，原对话不变。所选对话必须映射到同一项目。', '预览所选内容',
  ]),
  'zh-TW': messages('匯入歷史', [
    '將其他 Agent 的歷史對話與專案規則帶進 Yuri。', '讀取目前連線主機，不掃描瀏覽器或手機；原資料保持不變。',
    '請更新目前主機的 Yuri 和 OpenCode 後使用匯入。', '操作未完成，成功結果會保留；請檢查錯誤後重試。',
    '匯入進度', '已處理 {done} / {total}', '完成目前項目後停止', '正在匯入', '已完成', '部分完成', '已取消', '已中斷', '專案登記或索引更新需要重試',
    '確認匯入內容', '工具呼叫與結果以歷史文字保留，不會重播。保留可用的思考文字；遺失附件與原執行狀態無法還原，歷史用量標為未知。',
    '歷史對話', '合併為一個新對話', '匯入專案規則與技能', '未選取父對話的子對話將以獨立對話匯入。',
    '條件作用範圍以原文保留，啟用前請檢查適用條件。', '建立檔案', '現有檔案內容不同', '已存在，將略過', '保留現有', '兩份並存', '備份後取代', '檢視內容',
    '僅匯入所選對話；檔案衝突時保留現有內容。技能僅複製 SKILL.md，不含配套指令稿與資源。不複製或執行憑證、權限、hooks、MCP 命令及外掛。', '確認匯入', '資料來源', '自訂來源路徑', '可留空，自動尋找目前主機的標準目錄。',
    '正在掃描…', '尋找歷史對話', '{count} 個來源或檔案讀取失敗', '暫無可預覽的對話。', '取消全選', '全選', '匯入選項', '統一匯入到一個專案路徑',
    '依清單順序建立新對話，只移除完全相同的共同前綴，原對話不變。所選對話必須對應至同一專案。', '預覽所選內容',
  ]),
  ja: messages('履歴の取り込み', [
    '他のエージェントの会話とプロジェクトルールを Yuri に取り込みます。', '接続先ホストを読み取ります。ブラウザーやスマートフォンは走査せず、元のデータも変更しません。',
    'ホストの Yuri と OpenCode を更新してください。', '操作に失敗しました。成功した結果は保持されます。確認して再試行してください。',
    '取り込み状況', '{total} 件中 {done} 件を処理済み', '現在の項目の後で停止', '取り込み中', '完了', '一部完了', 'キャンセル済み', '中断', 'プロジェクト登録または索引更新の再試行が必要です',
    '内容の確認', 'ツール呼び出しと結果は再実行せずテキストで保存します。取得できる思考テキストは保持しますが、欠落した添付や実行状態は復元できません。過去の使用量は不明です。',
    '会話', '新しい会話に結合', 'プロジェクトのルールとスキルを取り込む', '親が未選択の子会話は独立した会話になります。',
    '条件の適用範囲は元のテキストで保持します。有効化前に確認してください。', 'ファイルを作成', '既存ファイルと異なります', '既存のためスキップ', '既存を保持', '両方を保持', 'バックアップして置換', '内容を表示',
    '選択した会話のみを取り込み、競合時は既存ファイルを保持します。スキルは SKILL.md のみで、付属スクリプトやリソースは含みません。認証情報、権限、hooks、MCP コマンド、プラグインはコピーも実行もしません。', '取り込みを確定', '取り込み元', '取り込み元のパス', '空欄の場合、このホストの標準フォルダーを検索します。',
    '検索中…', '会話を検索', '{count} 件の取り込み元またはファイルを読み取れませんでした', 'プレビューできる会話はありません。', 'すべて解除', 'すべて選択', '取り込みオプション', 'すべての取り込み先プロジェクト',
    '一覧順に新しい会話を作り、完全一致する共通の先頭部分だけを除きます。元の会話は変更しません。同じプロジェクトへの割り当てが必要です。', '選択内容をプレビュー',
  ]),
  ko: messages('기록 가져오기', [
    '다른 에이전트의 대화와 프로젝트 규칙을 Yuri로 가져옵니다.', '연결된 호스트만 읽습니다. 브라우저나 휴대폰은 검색하지 않으며 원본은 변경하지 않습니다.',
    '호스트의 Yuri와 OpenCode를 업데이트하세요.', '작업에 실패했습니다. 성공한 결과는 유지됩니다. 확인 후 재시도하세요.',
    '가져오기 진행 상황', '{total}개 중 {done}개 처리됨', '현재 항목 후 중지', '가져오는 중', '완료', '일부 완료', '취소됨', '중단됨', '프로젝트 등록 또는 색인 갱신을 재시도해야 합니다',
    '가져올 내용 검토', '도구 호출과 결과는 실행하지 않고 텍스트로 보관합니다. 가능한 추론 텍스트는 유지하지만 누락된 첨부와 실행 상태는 복원할 수 없습니다. 과거 사용량은 알 수 없음으로 표시합니다.',
    '대화', '새 대화로 합치기', '프로젝트 규칙 및 스킬 가져오기', '부모가 선택되지 않은 하위 대화는 독립된 대화가 됩니다.',
    '조건의 범위는 원문으로 유지됩니다. 활성화 전에 확인하세요.', '파일 만들기', '기존 파일과 다름', '이미 존재함 — 건너뛰기', '기존 항목 유지', '둘 다 유지', '백업 후 교체', '내용 보기',
    '선택한 대화만 가져오며 충돌 시 기존 파일을 유지합니다. 스킬은 SKILL.md만 복사하며 관련 스크립트와 리소스는 포함하지 않습니다. 자격 증명, 권한, hooks, MCP 명령 및 플러그인은 복사하거나 실행하지 않습니다.', '가져오기 확인', '데이터 출처', '사용자 지정 원본 경로', '비워 두면 호스트의 기본 폴더를 검색합니다.',
    '검색 중…', '대화 찾기', '{count}개 출처 또는 파일을 읽지 못했습니다', '미리 볼 수 있는 대화가 없습니다.', '모두 선택 해제', '모두 선택', '가져오기 옵션', '모든 항목의 대상 프로젝트',
    '목록 순서로 새 대화를 만들고 완전히 일치하는 공통 접두부만 제거합니다. 원본은 유지되며 같은 프로젝트에 연결해야 합니다.', '선택 내용 미리 보기',
  ]),
  es: messages('Importar historial', [
    'Trae a Yuri las conversaciones y reglas de otros agentes.', 'Lee el servidor conectado, no el navegador ni el teléfono. No modifica los originales.',
    'Actualiza Yuri y OpenCode en el servidor.', 'La operación falló. Los resultados correctos se conservan; revisa el error y reinténtalo.',
    'Progreso', '{done} de {total} procesados', 'Detener tras el elemento actual', 'Importando', 'Completado', 'Completado parcialmente', 'Cancelado', 'Interrumpido', 'Reintenta el registro del proyecto o la actualización del índice',
    'Revisar importación', 'Las herramientas y sus resultados se archivan como texto sin ejecutarse. Se conserva el razonamiento disponible, pero no se restauran adjuntos ausentes ni el estado de ejecución. El uso histórico es desconocido.',
    'Conversaciones', 'Combinar en una conversación nueva', 'Importar reglas y habilidades', 'Las conversaciones sin su principal seleccionada se importarán por separado.',
    'El alcance condicional se conserva como texto. Revísalo antes de activarlo.', 'Crear archivo', 'El archivo existente es diferente', 'Ya existe: omitir', 'Conservar existente', 'Conservar ambos', 'Reemplazar con copia de seguridad', 'Ver contenido',
    'Solo se importan las conversaciones seleccionadas; los conflictos conservan los archivos existentes. Las habilidades copian únicamente SKILL.md, sin scripts ni recursos auxiliares. No se copian ni ejecutan credenciales, permisos, hooks, comandos MCP ni complementos.', 'Confirmar importación', 'Orígenes', 'Ruta de origen personalizada', 'Déjala vacía para buscar en las carpetas habituales del servidor.',
    'Buscando…', 'Buscar conversaciones', 'No se pudieron leer {count} orígenes o archivos', 'No hay vista previa de conversaciones disponible.', 'Deseleccionar todo', 'Seleccionar todo', 'Opciones', 'Un proyecto para toda la selección',
    'Crea una conversación en el orden de la lista y elimina solo el prefijo común idéntico. No cambia los originales. Toda la selección debe usar el mismo proyecto.', 'Vista previa',
  ]),
  fr: messages('Importer l’historique', [
    'Importez dans Yuri les conversations et règles des autres agents.', 'Lit l’hôte connecté, pas le navigateur ou le téléphone. Les originaux restent inchangés.',
    'Mettez à jour Yuri et OpenCode sur l’hôte.', 'Échec de l’opération. Les résultats réussis sont conservés ; vérifiez et réessayez.',
    'Progression', '{done} éléments traités sur {total}', 'Arrêter après cet élément', 'Importation en cours', 'Terminé', 'Partiellement terminé', 'Annulé', 'Interrompu', 'Relancez l’enregistrement du projet ou la mise à jour de l’index',
    'Vérifier l’importation', 'Les outils et leurs résultats sont archivés en texte sans exécution. Le raisonnement disponible est conservé ; les pièces jointes absentes et l’état d’exécution ne sont pas restaurés. L’usage historique est inconnu.',
    'Conversations', 'Fusionner dans une nouvelle conversation', 'Importer les règles et compétences', 'Les conversations dont le parent n’est pas sélectionné seront indépendantes.',
    'La portée conditionnelle reste dans le texte. Vérifiez avant activation.', 'Créer un fichier', 'Le fichier existant est différent', 'Déjà présent — ignorer', 'Garder l’existant', 'Garder les deux', 'Remplacer avec sauvegarde', 'Voir le contenu',
    'Seules les conversations sélectionnées sont importées ; les fichiers existants sont conservés en cas de conflit. Les compétences copient uniquement SKILL.md, sans scripts ni ressources annexes. Identifiants, permissions, hooks, commandes MCP et modules ne sont ni copiés ni exécutés.', 'Confirmer l’importation', 'Sources', 'Chemin source personnalisé', 'Laissez vide pour rechercher dans les dossiers habituels de l’hôte.',
    'Recherche…', 'Rechercher des conversations', '{count} sources ou fichiers illisibles', 'Aucun aperçu de conversation disponible.', 'Tout désélectionner', 'Tout sélectionner', 'Options', 'Un projet pour toute la sélection',
    'Crée une conversation dans l’ordre de la liste et ne retire que le préfixe commun identique. Les originaux restent inchangés. Tous les éléments doivent viser le même projet.', 'Aperçu',
  ]),
  pl: messages('Importuj historię', [
    'Przenieś do Yuri rozmowy i reguły innych agentów.', 'Odczytuje połączony host, nie przeglądarkę ani telefon. Oryginały pozostają bez zmian.',
    'Zaktualizuj Yuri i OpenCode na hoście.', 'Operacja nie powiodła się. Udane wyniki zachowano; sprawdź błąd i ponów próbę.',
    'Postęp importu', 'Przetworzono {done} z {total}', 'Zatrzymaj po bieżącym elemencie', 'Importowanie', 'Ukończono', 'Częściowo ukończono', 'Anulowano', 'Przerwano', 'Ponów rejestrację projektu lub odświeżenie indeksu',
    'Sprawdź import', 'Narzędzia i wyniki są archiwizowane jako tekst bez wykonywania. Dostępne rozumowanie zostaje zachowane; brakujących załączników i stanu wykonania nie da się odtworzyć. Dawne użycie jest nieznane.',
    'Rozmowy', 'Połącz w nową rozmowę', 'Importuj reguły i umiejętności', 'Rozmowy bez wybranej rozmowy nadrzędnej będą niezależne.',
    'Zakres warunkowy pozostaje w tekście. Sprawdź go przed włączeniem.', 'Utwórz plik', 'Istniejący plik ma inną treść', 'Już istnieje — pomiń', 'Zachowaj istniejący', 'Zachowaj oba', 'Zastąp z kopią zapasową', 'Pokaż treść',
    'Importowane są tylko wybrane rozmowy; przy konflikcie istniejące pliki zostają zachowane. Umiejętności obejmują wyłącznie SKILL.md, bez skryptów i zasobów pomocniczych. Dane uwierzytelniające, uprawnienia, hooks, polecenia MCP i wtyczki nie są kopiowane ani wykonywane.', 'Potwierdź import', 'Źródła', 'Własna ścieżka źródłowa', 'Pozostaw puste, aby znaleźć standardowe foldery hosta.',
    'Wyszukiwanie…', 'Znajdź rozmowy', 'Nie odczytano {count} źródeł lub plików', 'Brak dostępnego podglądu rozmów.', 'Odznacz wszystko', 'Zaznacz wszystko', 'Opcje', 'Jeden projekt dla zaznaczenia',
    'Tworzy rozmowę w kolejności listy, usuwając tylko identyczny wspólny początek. Oryginały pozostają bez zmian. Wszystkie elementy muszą wskazywać ten sam projekt.', 'Podgląd',
  ]),
  'pt-BR': messages('Importar histórico', [
    'Traga ao Yuri as conversas e regras de outros agentes.', 'Lê o host conectado, não o navegador ou telefone. Os originais não mudam.',
    'Atualize o Yuri e o OpenCode no host.', 'A operação falhou. Os resultados bem-sucedidos foram mantidos; confira e tente novamente.',
    'Progresso', '{done} de {total} processados', 'Parar após o item atual', 'Importando', 'Concluído', 'Parcialmente concluído', 'Cancelado', 'Interrompido', 'Repita o registro do projeto ou a atualização do índice',
    'Revisar importação', 'Ferramentas e resultados são arquivados como texto, sem execução. O raciocínio disponível é mantido; anexos ausentes e estado de execução não são restaurados. O uso histórico é desconhecido.',
    'Conversas', 'Combinar em uma conversa nova', 'Importar regras e habilidades', 'Conversas sem a principal selecionada serão independentes.',
    'O escopo condicional é mantido como texto. Revise antes de ativar.', 'Criar arquivo', 'O arquivo existente é diferente', 'Já existe — ignorar', 'Manter existente', 'Manter ambos', 'Substituir com backup', 'Ver conteúdo',
    'Só as conversas selecionadas são importadas; os arquivos existentes são mantidos em caso de conflito. Habilidades copiam apenas SKILL.md, sem scripts ou recursos auxiliares. Credenciais, permissões, hooks, comandos MCP e plugins não são copiados nem executados.', 'Confirmar importação', 'Origens', 'Caminho de origem personalizado', 'Deixe vazio para buscar nas pastas padrão do host.',
    'Buscando…', 'Encontrar conversas', 'Não foi possível ler {count} origens ou arquivos', 'Nenhuma prévia de conversa disponível.', 'Desmarcar tudo', 'Selecionar tudo', 'Opções', 'Um projeto para toda a seleção',
    'Cria uma conversa na ordem da lista e remove só o prefixo comum idêntico. As originais não mudam. Toda a seleção deve apontar para o mesmo projeto.', 'Prévia',
  ]),
  uk: messages('Імпорт історії', [
    'Перенесіть до Yuri розмови й правила інших агентів.', 'Читає підключений хост, а не браузер чи телефон. Оригінали не змінюються.',
    'Оновіть Yuri та OpenCode на хості.', 'Операція не вдалася. Успішні результати збережено; перевірте помилку й повторіть спробу.',
    'Перебіг імпорту', 'Оброблено {done} із {total}', 'Зупинити після поточного елемента', 'Імпортування', 'Завершено', 'Частково завершено', 'Скасовано', 'Перервано', 'Повторіть реєстрацію проєкту або оновлення індексу',
    'Перевірка імпорту', 'Інструменти й результати зберігаються як текст без виконання. Доступні міркування зберігаються; відсутні вкладення та стан виконання не відновлюються. Історичне використання невідоме.',
    'Розмови', 'Об’єднати в нову розмову', 'Імпортувати правила й навички', 'Розмови без вибраної батьківської розмови будуть незалежними.',
    'Умовна область дії зберігається в тексті. Перевірте перед увімкненням.', 'Створити файл', 'Наявний файл відрізняється', 'Уже існує — пропустити', 'Зберегти наявний', 'Зберегти обидва', 'Замінити з резервною копією', 'Переглянути вміст',
    'Імпортуються лише вибрані розмови; у разі конфлікту наявні файли зберігаються. Навички копіюють тільки SKILL.md, без допоміжних скриптів і ресурсів. Облікові дані, дозволи, hooks, команди MCP і плагіни не копіюються та не виконуються.', 'Підтвердити імпорт', 'Джерела', 'Власний шлях джерела', 'Залиште порожнім для пошуку стандартних папок хоста.',
    'Пошук…', 'Знайти розмови', 'Не вдалося прочитати {count} джерел або файлів', 'Попередній перегляд розмов недоступний.', 'Зняти всі позначки', 'Вибрати все', 'Параметри', 'Один проєкт для всього вибраного',
    'Створює розмову в порядку списку та видаляє лише однаковий спільний початок. Оригінали не змінюються. Усі елементи мають належати одному проєкту.', 'Переглянути вибране',
  ]),
};

const cardCopy = (heading: string, next: string, installed: string, notDetected: string, unknown: string, previous: string, nextPage: string, messageCount: string) => ({
  'historyImport.heading': heading,
  'historyImport.next': next,
  'historyImport.installed': installed,
  'historyImport.notDetected': notDetected,
  'historyImport.installationUnknown': unknown,
  'historyImport.previousPage': previous,
  'historyImport.nextPage': nextPage,
  'historyImport.messages': messageCount,
});

const countCopy = (estimated: string, exact: string, unavailable: string) => ({
  'historyImport.estimatedCount': estimated,
  'historyImport.sourceCount': exact,
  'historyImport.countUnavailable': unavailable,
});

const historyImportCardMessages = {
  en: { ...historyImportBaseMessages.en, ...cardCopy('Import from these tools', 'Next', 'Installed on this Host', 'Installation not detected on this Host', 'Installation status unknown', 'Previous page', 'Next page', 'Messages'), ...countCopy('About {count} conversations, estimated from history files and indexes', '{count} conversations', 'Conversation count unavailable') },
  'zh-CN': { ...historyImportBaseMessages['zh-CN'], ...cardCopy('从这些工具中导入', '下一步', '当前主机已安装', '未检测到当前主机安装', '安装状态未知', '上一页', '下一页', '消息'), ...countCopy('约 {count} 条对话，根据历史文件和索引估算', '{count} 条对话', '暂时无法统计对话数量') },
  'zh-TW': { ...historyImportBaseMessages['zh-TW'], ...cardCopy('從這些工具中匯入', '下一步', '目前主機已安裝', '未偵測到目前主機安裝', '安裝狀態未知', '上一頁', '下一頁', '訊息'), ...countCopy('約 {count} 則對話，依歷史檔案與索引估算', '{count} 則對話', '暫時無法統計對話數量') },
  ja: { ...historyImportBaseMessages.ja, ...cardCopy('これらのツールから取り込む', '次へ', '接続先ホストにインストール済み', '接続先ホストへのインストールは未検出', 'インストール状態は不明', '前のページ', '次のページ', 'メッセージ'), ...countCopy('履歴ファイルと索引から推定した約 {count} 件の会話', '{count} 件の会話', '会話数を取得できません') },
  ko: { ...historyImportBaseMessages.ko, ...cardCopy('다음 도구에서 가져오기', '다음', '연결된 호스트에 설치됨', '연결된 호스트에서 설치를 감지하지 못함', '설치 상태를 알 수 없음', '이전 페이지', '다음 페이지', '메시지'), ...countCopy('기록 파일과 색인으로 추정한 약 {count}개의 대화', '{count}개의 대화', '대화 수를 확인할 수 없음') },
  es: { ...historyImportBaseMessages.es, ...cardCopy('Importar desde estas herramientas', 'Siguiente', 'Instalado en este servidor', 'No se detectó la instalación en este servidor', 'Estado de instalación desconocido', 'Página anterior', 'Página siguiente', 'Mensajes'), ...countCopy('Unas {count} conversaciones, estimadas a partir de archivos e índices', '{count} conversaciones', 'Cantidad de conversaciones no disponible') },
  fr: { ...historyImportBaseMessages.fr, ...cardCopy('Importer depuis ces outils', 'Suivant', 'Installé sur cet hôte', 'Installation non détectée sur cet hôte', 'État d’installation inconnu', 'Page précédente', 'Page suivante', 'Messages de conversation'), ...countCopy('Environ {count} conversations, estimées à partir des fichiers et index', '{count} conversations', 'Nombre de conversations indisponible') },
  pl: { ...historyImportBaseMessages.pl, ...cardCopy('Importuj z tych narzędzi', 'Dalej', 'Zainstalowano na tym hoście', 'Nie wykryto instalacji na tym hoście', 'Nieznany stan instalacji', 'Poprzednia strona', 'Następna strona', 'Wiadomości'), ...countCopy('Około {count} rozmów, oszacowanych na podstawie plików i indeksów', '{count} rozmów', 'Liczba rozmów jest niedostępna') },
  'pt-BR': { ...historyImportBaseMessages['pt-BR'], ...cardCopy('Importar destas ferramentas', 'Próximo', 'Instalado neste host', 'Instalação não detectada neste host', 'Estado da instalação desconhecido', 'Página anterior', 'Próxima página', 'Mensagens'), ...countCopy('Cerca de {count} conversas, estimadas a partir de arquivos e índices', '{count} conversas', 'Quantidade de conversas indisponível') },
  uk: { ...historyImportBaseMessages.uk, ...cardCopy('Імпортувати з цих інструментів', 'Далі', 'Установлено на цьому хості', 'Установлення на цьому хості не виявлено', 'Стан установлення невідомий', 'Попередня сторінка', 'Наступна сторінка', 'Повідомлення'), ...countCopy('Приблизно {count} розмов за оцінкою файлів та індексів', '{count} розмов', 'Кількість розмов недоступна') },
};

const progressCopy = (scanning: string, validating: string, importing: string, background: string, indexing: string, unavailable: string) => ({
  'historyImport.phase.scanning': scanning,
  'historyImport.phase.validating': validating,
  'historyImport.phase.importing': importing,
  'historyImport.background': background,
  'backgroundTasks.indexing': indexing,
  'backgroundTasks.progressUnavailable': unavailable,
});

const taskCopy = (title: string, importing: string, index: string, download: string, empty: string, processed: string, downloaded: string) => ({
  'backgroundTasks.title': title,
  'backgroundTasks.import': importing,
  'backgroundTasks.index': index,
  'backgroundTasks.download': download,
  'backgroundTasks.empty': empty,
  'backgroundTasks.processed': processed,
  'backgroundTasks.downloaded': downloaded,
});

const historyImportTaskMessages = {
  en: { ...historyImportCardMessages.en, ...progressCopy('Scanning history', 'Validating history', 'Importing history', 'Continue in background', 'Indexing conversations', 'Refreshing progress'), ...taskCopy('Background tasks', 'Importing', 'Indexing', 'Downloading', 'No background tasks', 'Processed {completed} / {total}', 'Downloaded {completed} / {total} bytes') },
  'zh-CN': { ...historyImportCardMessages['zh-CN'], ...progressCopy('扫描历史', '校验历史', '导入历史', '后台导入', '索引对话', '正在重新获取进度'), ...taskCopy('后台任务', '导入', '索引', '下载', '暂无后台任务', '已处理 {completed} / {total}', '已下载 {completed} / {total} 字节') },
  'zh-TW': { ...historyImportCardMessages['zh-TW'], ...progressCopy('掃描歷史', '驗證歷史', '匯入歷史', '背景匯入', '索引對話', '正在重新取得進度'), ...taskCopy('背景工作', '匯入', '索引中', '下載', '目前沒有背景工作', '已處理 {completed} / {total}', '已下載 {completed} / {total} 位元組') },
  ja: { ...historyImportCardMessages.ja, ...progressCopy('履歴を検索中', '履歴を検証中', '履歴を取り込み中', 'バックグラウンドで続行', '会話を索引化中', '進捗を再取得中'), ...taskCopy('バックグラウンドタスク', '取り込み', '索引作成', 'ダウンロード', '実行中のタスクはありません', '{completed} / {total} 件を処理済み', '{completed} / {total} バイトを取得済み') },
  ko: { ...historyImportCardMessages.ko, ...progressCopy('기록 검색 중', '기록 검증 중', '기록 가져오는 중', '백그라운드에서 계속', '대화 색인 중', '진행 상황 새로 고치는 중'), ...taskCopy('백그라운드 작업', '가져오기', '색인', '다운로드', '진행 중인 백그라운드 작업 없음', '{completed} / {total} 처리됨', '{completed} / {total} 바이트 다운로드됨') },
  es: { ...historyImportCardMessages.es, ...progressCopy('Buscando historial', 'Validando historial', 'Importando historial', 'Continuar en segundo plano', 'Indexando conversaciones', 'Actualizando progreso'), ...taskCopy('Tareas en segundo plano', 'Importando', 'Indexando', 'Descargando', 'Sin tareas en segundo plano', 'Procesado: {completed} / {total}', 'Descargado: {completed} / {total} bytes') },
  fr: { ...historyImportCardMessages.fr, ...progressCopy('Recherche de l’historique', 'Validation de l’historique', 'Importation de l’historique', 'Continuer en arrière-plan', 'Indexation des conversations', 'Actualisation de la progression'), ...taskCopy('Tâches en arrière-plan', 'Importation', 'Indexation', 'Téléchargement', 'Aucune tâche en arrière-plan', 'Traités : {completed} / {total}', 'Téléchargés : {completed} / {total} octets') },
  pl: { ...historyImportCardMessages.pl, ...progressCopy('Skanowanie historii', 'Weryfikacja historii', 'Importowanie historii', 'Kontynuuj w tle', 'Indeksowanie rozmów', 'Odświeżanie postępu'), ...taskCopy('Zadania w tle', 'Importowanie', 'Indeksowanie', 'Pobieranie', 'Brak zadań w tle', 'Przetworzono {completed} / {total}', 'Pobrano {completed} / {total} bajtów') },
  'pt-BR': { ...historyImportCardMessages['pt-BR'], ...progressCopy('Buscando histórico', 'Validando histórico', 'Importando histórico', 'Continuar em segundo plano', 'Indexando conversas', 'Atualizando progresso'), ...taskCopy('Tarefas em segundo plano', 'Importando', 'Indexando', 'Baixando', 'Nenhuma tarefa em segundo plano', 'Processados: {completed} / {total}', 'Baixados: {completed} / {total} bytes') },
  uk: { ...historyImportCardMessages.uk, ...progressCopy('Сканування історії', 'Перевірка історії', 'Імпортування історії', 'Продовжити у фоні', 'Індексування розмов', 'Оновлення перебігу'), ...taskCopy('Фонові завдання', 'Імпортування', 'Індексація', 'Завантаження', 'Немає фонових завдань', 'Оброблено {completed} / {total}', 'Завантажено {completed} / {total} байтів') },
};

const importedCopy = (subtitle: string, imported: string) => ({
  'historyImport.deduplication': subtitle,
  'historyImport.alreadyImported': imported,
});

const recoveryCopy = (resume: string, resuming: string, failed: string, missing: string, index: string, download: string, changed: string, count: string) => ({
  'backgroundTasks.resume': resume,
  'backgroundTasks.resuming': resuming,
  'backgroundTasks.resumeFailed': failed,
  'backgroundTasks.originalSelectionMissing': missing,
  'backgroundTasks.indexFailed': index,
  'backgroundTasks.downloadFailed': download,
  'backgroundTasks.updateChanged': changed,
  'backgroundTasks.failedCount': count,
});

const recoveryMessages = {
  en: recoveryCopy('Continue', 'Continuing…', 'Could not continue. Successful results are kept; try again.', 'This older task did not save its original selection and cannot be resumed. Successful results are kept.', 'Indexing incomplete', 'Update interrupted', 'The original update is no longer available. Check updates before starting a new version.', 'Failed: {count}'),
  'zh-CN': recoveryCopy('继续', '正在继续…', '继续失败，成功结果已保留，请重试。', '此旧任务未保存原选择，无法继续；成功结果已保留。', '索引未完成', '更新已中断', '原更新版本已不可用，请检查更新后再选择新版本。', '失败项：{count}'),
  'zh-TW': recoveryCopy('繼續', '正在繼續…', '繼續失敗，成功結果已保留，請重試。', '此舊工作未儲存原選擇，無法繼續；成功結果已保留。', '索引未完成', '更新已中斷', '原更新版本已無法使用，請檢查更新後再選擇新版本。', '失敗項目：{count}'),
  ja: recoveryCopy('続行', '続行中…', '続行できませんでした。成功した結果は保持されています。再試行してください。', 'この古いタスクは元の選択が保存されていないため再開できません。成功した結果は保持されています。', '索引作成は未完了', '更新は中断されました', '元の更新は利用できません。更新を確認して新しいバージョンを選択してください。', '失敗：{count}'),
  ko: recoveryCopy('계속', '계속하는 중…', '계속하지 못했습니다. 성공한 결과는 유지됩니다. 다시 시도하세요.', '이전 작업의 원래 선택이 저장되지 않아 계속할 수 없습니다. 성공한 결과는 유지됩니다.', '색인 미완료', '업데이트 중단됨', '원래 업데이트를 사용할 수 없습니다. 업데이트를 확인한 후 새 버전을 선택하세요.', '실패: {count}'),
  es: recoveryCopy('Continuar', 'Continuando…', 'No se pudo continuar. Se conservan los resultados correctos; reinténtalo.', 'Esta tarea antigua no guardó la selección original y no puede reanudarse. Se conservan los resultados correctos.', 'Indexación incompleta', 'Actualización interrumpida', 'La actualización original ya no está disponible. Busca actualizaciones antes de elegir otra versión.', 'Fallos: {count}'),
  fr: recoveryCopy('Continuer', 'Reprise…', 'Reprise impossible. Les résultats réussis sont conservés ; réessayez.', 'Cette ancienne tâche n’a pas enregistré la sélection d’origine et ne peut pas reprendre. Les résultats réussis sont conservés.', 'Indexation incomplète', 'Mise à jour interrompue', 'La mise à jour d’origine n’est plus disponible. Vérifiez les mises à jour avant de choisir une autre version.', 'Échecs : {count}'),
  pl: recoveryCopy('Kontynuuj', 'Wznawianie…', 'Nie udało się wznowić. Udane wyniki zachowano; spróbuj ponownie.', 'To starsze zadanie nie zapisało pierwotnego wyboru i nie można go wznowić. Udane wyniki zachowano.', 'Indeksowanie nieukończone', 'Aktualizacja przerwana', 'Pierwotna aktualizacja jest niedostępna. Sprawdź aktualizacje przed wybraniem innej wersji.', 'Błędy: {count}'),
  'pt-BR': recoveryCopy('Continuar', 'Continuando…', 'Não foi possível continuar. Os resultados bem-sucedidos foram mantidos; tente novamente.', 'Esta tarefa antiga não salvou a seleção original e não pode ser retomada. Os resultados bem-sucedidos foram mantidos.', 'Indexação incompleta', 'Atualização interrompida', 'A atualização original não está mais disponível. Verifique as atualizações antes de escolher outra versão.', 'Falhas: {count}'),
  uk: recoveryCopy('Продовжити', 'Відновлення…', 'Не вдалося продовжити. Успішні результати збережено; спробуйте ще раз.', 'Це старе завдання не зберегло початковий вибір, тому його неможливо продовжити. Успішні результати збережено.', 'Індексування не завершено', 'Оновлення перервано', 'Початкове оновлення більше недоступне. Перевірте оновлення, перш ніж вибирати іншу версію.', 'Помилки: {count}'),
};

const dismissCopy = (dismiss: string, removing: string, failed: string) => ({
  'backgroundTasks.dismiss': dismiss,
  'backgroundTasks.removing': removing,
  'backgroundTasks.dismissFailed': failed,
});
const dismissalMessages = {
  en: dismissCopy('Remove', 'Removing…', 'Could not remove this record. Try again.'),
  'zh-CN': dismissCopy('移除', '正在移除…', '移除记录失败，请重试。'),
  'zh-TW': dismissCopy('移除', '正在移除…', '移除紀錄失敗，請重試。'),
  ja: dismissCopy('削除', '削除中…', '記録を削除できませんでした。再試行してください。'),
  ko: dismissCopy('제거', '제거 중…', '기록을 제거하지 못했습니다. 다시 시도하세요.'),
  es: dismissCopy('Quitar', 'Quitando…', 'No se pudo quitar el registro. Reinténtalo.'),
  fr: dismissCopy('Retirer', 'Suppression…', 'Impossible de retirer cette entrée. Réessayez.'),
  pl: dismissCopy('Usuń', 'Usuwanie…', 'Nie udało się usunąć wpisu. Spróbuj ponownie.'),
  'pt-BR': dismissCopy('Remover', 'Removendo…', 'Não foi possível remover o registro. Tente novamente.'),
  uk: dismissCopy('Прибрати', 'Видалення…', 'Не вдалося прибрати запис. Спробуйте ще раз.'),
};

export const historyImportMessages = {
  en: { ...historyImportTaskMessages.en, ...recoveryMessages.en, ...dismissalMessages.en, ...importedCopy('Duplicate conversations will not be imported again', 'Already imported') },
  'zh-CN': { ...historyImportTaskMessages['zh-CN'], ...recoveryMessages['zh-CN'], ...dismissalMessages['zh-CN'], ...importedCopy('重复对话不会再次导入', '已导入') },
  'zh-TW': { ...historyImportTaskMessages['zh-TW'], ...recoveryMessages['zh-TW'], ...dismissalMessages['zh-TW'], ...importedCopy('重複對話不會再次匯入', '已匯入') },
  ja: { ...historyImportTaskMessages.ja, ...recoveryMessages.ja, ...dismissalMessages.ja, ...importedCopy('重複する会話は再度取り込まれません', '取り込み済み') },
  ko: { ...historyImportTaskMessages.ko, ...recoveryMessages.ko, ...dismissalMessages.ko, ...importedCopy('중복 대화는 다시 가져오지 않습니다', '이미 가져옴') },
  es: { ...historyImportTaskMessages.es, ...recoveryMessages.es, ...dismissalMessages.es, ...importedCopy('Las conversaciones duplicadas no se volverán a importar', 'Ya importada') },
  fr: { ...historyImportTaskMessages.fr, ...recoveryMessages.fr, ...dismissalMessages.fr, ...importedCopy('Les conversations en double ne seront pas réimportées', 'Déjà importée') },
  pl: { ...historyImportTaskMessages.pl, ...recoveryMessages.pl, ...dismissalMessages.pl, ...importedCopy('Zduplikowane rozmowy nie zostaną ponownie zaimportowane', 'Już zaimportowano') },
  'pt-BR': { ...historyImportTaskMessages['pt-BR'], ...recoveryMessages['pt-BR'], ...dismissalMessages['pt-BR'], ...importedCopy('Conversas duplicadas não serão importadas novamente', 'Já importada') },
  uk: { ...historyImportTaskMessages.uk, ...recoveryMessages.uk, ...dismissalMessages.uk, ...importedCopy('Дублікати розмов не імпортуватимуться повторно', 'Уже імпортовано') },
};
