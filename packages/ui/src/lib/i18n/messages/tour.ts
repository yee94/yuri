const keys = ['tour.voiceAllowance', 'tour.voiceHeading', 'tour.voiceIntro', 'tour.dictationDescription', 'tour.readAloudTitle', 'tour.readAloudDescription', 'tour.configureInput', 'tour.configureReadAloud', 'tour.morePlugins', 'tour.title', 'tour.description', 'tour.models', 'tour.plugins', 'tour.voice', 'tour.metadataUnavailable', 'tour.saved', 'tour.saveFailed', 'tour.noModels', 'tour.operationFailed', 'tour.magpieNote', 'tour.otherProvider', 'tour.voiceDescription', 'tour.voiceQuota', 'tour.configureVoice', 'tour.later', 'tour.finish', 'tour.continue', 'tour.open'] as const;
import { historyImportMessages } from './history-import';

type TourMessages = Record<typeof keys[number], string>;
const messages = (values: readonly string[]): TourMessages => {
  if (values.length !== keys.length) throw new Error('Incomplete tour translations');
  return Object.fromEntries(keys.map((key, index) => [key, values[index]])) as TourMessages;
};
const tourStepMessages = {
  en: messages([
    'Supports voice input and read-aloud, with a free allowance usually sufficient for light personal use.',
    'Speak your thoughts. Hear the reply.', 'Choose voice input and read-aloud independently, with local or cloud services.', 'Turn spoken ideas into text in your composer.', 'Read aloud', 'Listen to replies while you keep working.', 'Set up voice input', 'Set up read-aloud',
    'More OpenCode plugins',
    'Hi, welcome to Yuri — get ready in four steps', 'Connect a model, add tools, import history, then set up voice. Every step can wait.', 'Models', 'Tools', 'Voice',
    'Plugin information is unavailable. Please retry.', 'Configured', 'Could not save: {names}. Successful changes are kept.',
    'No models are available. Connect a provider, then retry.', 'The operation failed. Saved changes are kept; please retry.',
    'Magpie is itself a plugin. Add it here once; it is not selected again in the tools step.', 'Use another provider', 'Doubao speech by Volcengine supports dictation and reading replies aloud.', 'Free allowances support personal trials. Quotas, expiry and overage charges are determined by the Volcengine console.', 'Set up Doubao voice', 'Set up later', 'Start using Yuri', 'Save and continue', 'Open setup tour',
  ]),
  'zh-CN': messages([
    '支持语音输入与回答朗读，提供免费额度，个人日常轻量使用通常够用。',
    '说出想法，听见回答。', '语音输入与回答朗读可以分别配置，本地运行或云端服务，由你选择。', '把口述的想法变成输入框里的文字。', '回答朗读', '让回答读给你听，继续专注手头的事。', '设置语音输入', '设置回答朗读',
    '更多 OpenCode 插件',
    '你好，欢迎使用 Yuri，四步准备就绪', '连上模型，添上工具，导入历史，再设置语音。每一步都可以稍后再配。', '接入模型', '扩展工具', '设置语音',
    '无法加载插件信息，请重试。', '已配置', '未能保存：{names}。其他已成功的更改会保留。',
    '暂未发现可用模型，请完成 Provider 配置后重试。', '操作未完成，已保存的更改会保留，请重试。',
    'Magpie 本身就是插件，在这里添加并接入，下一步不再重复选择。', '使用其他 Provider', '推荐火山引擎的豆包语音，同时支持口述需求转文字与回答朗读。', '可先使用免费额度体验个人使用，具体额度、有效期及超额费用以火山引擎控制台为准。', '配置豆包语音', '稍后配置', '开始使用', '保存并继续', '打开设置引导',
  ]),
  'zh-TW': messages([
    '支援語音輸入與回答朗讀，提供免費額度，個人日常輕量使用通常足夠。',
    '說出想法，聽見回答。', '語音輸入與回答朗讀可以分別設定，本機執行或雲端服務，由你選擇。', '把口述的想法變成輸入框裡的文字。', '回答朗讀', '讓回答讀給你聽，繼續專注手邊的事。', '設定語音輸入', '設定回答朗讀',
    '更多 OpenCode 外掛',
    '你好，歡迎使用 Yuri，四步準備就緒', '連接模型、加入工具、匯入歷史，再設定語音。每一步都可以稍後再設定。', '連接模型', '擴充工具', '設定語音',
    '無法載入外掛資訊，請重試。', '已設定', '無法儲存：{names}。其他成功的變更會保留。',
    '尚未找到可用模型，請設定供應商後重試。', '操作未完成，已儲存的變更會保留，請重試。',
    'Magpie 本身就是外掛，在這裡加入並連接，下一步不會重複選擇。', '使用其他供應商', '推薦火山引擎的豆包語音，支援口述需求轉文字與回覆朗讀。', '可先使用免費額度體驗，實際額度、有效期限及超額費用以火山引擎主控台為準。', '設定豆包語音', '稍後設定', '開始使用', '儲存並繼續', '開啟設定導覽',
  ]),
  ja: messages([
    '音声入力と読み上げに対応。無料枠があり、個人での軽い日常利用なら通常は十分です。',
    '思いを話す。答えを聴く。', '音声入力と読み上げを個別に設定できます。ローカルでもクラウドでも。', '話したアイデアを入力欄のテキストに変換します。', '回答の読み上げ', '作業を続けながら回答を聴けます。', '音声入力を設定', '読み上げを設定',
    'その他の OpenCode プラグイン',
    'こんにちは、Yuri へようこそ。4ステップで準備完了', 'モデル接続、ツール追加、履歴の取り込み、音声設定。各手順は後回しにできます。', 'モデル', 'ツール', '音声',
    'プラグイン情報を取得できません。再試行してください。', '設定済み', '保存できませんでした：{names}。成功した変更は保持されます。',
    'モデルがありません。プロバイダーを接続して再試行してください。', '操作に失敗しました。保存済みの変更は保持されます。再試行してください。',
    'Magpie 自体がプラグインです。ここで一度追加し、ツールの手順では再選択しません。', '別のプロバイダーを使う', 'Volcengine の Doubao 音声は音声入力と回答の読み上げに対応しています。', '無料枠で個人利用を試せます。上限、有効期限、超過料金は Volcengine コンソールをご確認ください。', 'Doubao 音声を設定', '後で設定', '使い始める', '保存して次へ', 'セットアップガイドを開く',
  ]),
  ko: messages([
    '음성 입력과 답변 읽기를 지원하며, 가벼운 개인 일상 사용에 대체로 충분한 무료 제공량이 있습니다.',
    '생각을 말하고, 답변을 들으세요.', '음성 입력과 답변 읽기를 각각 설정하세요. 로컬 또는 클라우드 서비스를 선택할 수 있습니다.', '말한 생각을 입력창의 텍스트로 바꿉니다.', '답변 읽기', '작업을 계속하면서 답변을 들으세요.', '음성 입력 설정', '답변 읽기 설정',
    '더 많은 OpenCode 플러그인',
    '안녕하세요, Yuri에 오신 것을 환영합니다. 네 단계로 준비하세요', '모델 연결, 도구 추가, 기록 가져오기, 음성 설정. 각 단계는 나중에 진행해도 됩니다.', '모델', '도구', '음성',
    '플러그인 정보를 불러올 수 없습니다. 다시 시도하세요.', '설정됨', '저장하지 못했습니다: {names}. 성공한 변경 사항은 유지됩니다.',
    '사용 가능한 모델이 없습니다. 공급자를 연결한 후 다시 시도하세요.', '작업에 실패했습니다. 저장된 변경 사항은 유지됩니다. 다시 시도하세요.',
    'Magpie 자체가 플러그인입니다. 여기서 한 번 추가하면 도구 단계에서 다시 선택하지 않습니다.', '다른 공급자 사용', 'Volcengine의 Doubao 음성은 받아쓰기와 답변 읽기를 지원합니다.', '무료 제공량으로 개인 사용을 체험할 수 있습니다. 한도, 유효 기간 및 초과 요금은 Volcengine 콘솔을 확인하세요.', 'Doubao 음성 설정', '나중에 설정', '사용 시작', '저장하고 계속', '설정 안내 열기',
  ]),
  es: messages([
    'Admite dictado y lectura en voz alta, con una cuota gratuita normalmente suficiente para un uso personal ligero.',
    'Expresa tus ideas. Escucha la respuesta.', 'Configura el dictado y la lectura por separado, con servicios locales o en la nube.', 'Convierte tus ideas habladas en texto en el cuadro de entrada.', 'Lectura en voz alta', 'Escucha las respuestas mientras sigues trabajando.', 'Configurar dictado', 'Configurar lectura',
    'Más complementos de OpenCode',
    'Hola, te damos la bienvenida a Yuri. Prepárate en cuatro pasos', 'Conecta un modelo, añade herramientas, importa el historial y configura la voz. Puedes hacerlo más tarde.', 'Modelos', 'Herramientas', 'Voz',
    'No se pudo cargar la información del complemento. Reinténtalo.', 'Configurado', 'No se pudo guardar: {names}. Los cambios correctos se conservan.',
    'No hay modelos disponibles. Conecta un proveedor y reinténtalo.', 'La operación falló. Los cambios guardados se conservan; reinténtalo.',
    'Magpie es un complemento. Se añade aquí una sola vez, sin volver a seleccionarlo en herramientas.', 'Usar otro proveedor', 'La voz Doubao de Volcengine permite dictar y escuchar las respuestas.', 'Puedes probar el servicio con la cuota gratuita. Consulta límites, caducidad y cargos adicionales en la consola de Volcengine.', 'Configurar voz Doubao', 'Configurar más tarde', 'Empezar a usar Yuri', 'Guardar y continuar', 'Abrir guía de configuración',
  ]),
  fr: messages([
    'Prend en charge la dictée et la lecture, avec un quota gratuit généralement suffisant pour un usage personnel léger.',
    'Exprimez vos idées. Écoutez la réponse.', 'Configurez séparément la dictée et la lecture, avec des services locaux ou en ligne.', 'Transformez vos idées dictées en texte dans la zone de saisie.', 'Lecture des réponses', 'Écoutez les réponses tout en continuant à travailler.', 'Configurer la dictée', 'Configurer la lecture',
    'Plus de modules OpenCode',
    'Bonjour, bienvenue sur Yuri. Préparez-vous en quatre étapes', 'Connectez un modèle, ajoutez des outils, importez l’historique, puis configurez la voix. Chaque étape peut attendre.', 'Modèles', 'Outils', 'Voix',
    'Les informations du module sont indisponibles. Réessayez.', 'Configuré', 'Enregistrement impossible : {names}. Les modifications réussies sont conservées.',
    'Aucun modèle disponible. Connectez un fournisseur, puis réessayez.', 'L’opération a échoué. Les modifications enregistrées sont conservées ; réessayez.',
    'Magpie est un module. Ajoutez-le ici une seule fois, sans le sélectionner à nouveau à l’étape des outils.', 'Utiliser un autre fournisseur', 'La voix Doubao de Volcengine permet de dicter et d’écouter les réponses.', 'Le quota gratuit permet un essai personnel. Consultez les limites, la validité et les frais de dépassement dans la console Volcengine.', 'Configurer la voix Doubao', 'Configurer plus tard', 'Commencer à utiliser Yuri', 'Enregistrer et continuer', 'Ouvrir le guide de configuration',
  ]),
  pl: messages([
    'Obsługuje dyktowanie i odczytywanie, a bezpłatny limit zwykle wystarcza do lekkiego użytku osobistego.',
    'Wypowiedz myśli. Usłysz odpowiedź.', 'Skonfiguruj osobno dyktowanie i odczytywanie, lokalnie lub w chmurze.', 'Zamień wypowiedziane pomysły na tekst w polu wiadomości.', 'Odczytywanie odpowiedzi', 'Słuchaj odpowiedzi, kontynuując pracę.', 'Skonfiguruj dyktowanie', 'Skonfiguruj odczytywanie',
    'Więcej wtyczek OpenCode',
    'Cześć, witaj w Yuri. Przygotuj się w czterech krokach', 'Połącz model, dodaj narzędzia, importuj historię i skonfiguruj głos. Każdy krok możesz odłożyć.', 'Modele', 'Narzędzia', 'Głos',
    'Nie można wczytać informacji o wtyczce. Spróbuj ponownie.', 'Skonfigurowano', 'Nie udało się zapisać: {names}. Udane zmiany zachowano.',
    'Brak modeli. Połącz dostawcę i spróbuj ponownie.', 'Operacja nie powiodła się. Zapisane zmiany zachowano; spróbuj ponownie.',
    'Magpie jest wtyczką. Dodajesz ją tutaj tylko raz, bez ponownego wyboru w kroku narzędzi.', 'Użyj innego dostawcy', 'Głos Doubao firmy Volcengine obsługuje dyktowanie i odczytywanie odpowiedzi.', 'Bezpłatny limit umożliwia osobiste wypróbowanie usługi. Limity, ważność i opłaty za przekroczenie sprawdzisz w konsoli Volcengine.', 'Skonfiguruj głos Doubao', 'Skonfiguruj później', 'Zacznij korzystać', 'Zapisz i kontynuuj', 'Otwórz przewodnik konfiguracji',
  ]),
  'pt-BR': messages([
    'Oferece ditado e leitura em voz alta, com uma cota gratuita geralmente suficiente para uso pessoal leve.',
    'Fale suas ideias. Ouça a resposta.', 'Configure o ditado e a leitura separadamente, com serviços locais ou na nuvem.', 'Transforme suas ideias faladas em texto no campo de mensagem.', 'Leitura das respostas', 'Ouça as respostas enquanto continua trabalhando.', 'Configurar ditado', 'Configurar leitura',
    'Mais plugins do OpenCode',
    'Olá, boas-vindas ao Yuri. Prepare-se em quatro etapas', 'Conecte um modelo, adicione ferramentas, importe o histórico e configure a voz. Cada etapa pode ficar para depois.', 'Modelos', 'Ferramentas', 'Voz',
    'Não foi possível carregar as informações do plugin. Tente novamente.', 'Configurado', 'Não foi possível salvar: {names}. As alterações bem-sucedidas foram mantidas.',
    'Nenhum modelo disponível. Conecte um provedor e tente novamente.', 'A operação falhou. As alterações salvas foram mantidas; tente novamente.',
    'O Magpie é um plugin. Adicione-o aqui uma vez, sem selecioná-lo novamente na etapa de ferramentas.', 'Usar outro provedor', 'A voz Doubao da Volcengine permite ditar e ouvir as respostas.', 'A cota gratuita permite testar o uso pessoal. Consulte limites, validade e cobranças excedentes no console da Volcengine.', 'Configurar voz Doubao', 'Configurar depois', 'Começar a usar', 'Salvar e continuar', 'Abrir guia de configuração',
  ]),
  uk: messages([
    'Підтримує диктування й озвучення, з безкоштовною квотою, якої зазвичай достатньо для помірного особистого використання.',
    'Висловіть думки. Почуйте відповідь.', 'Налаштуйте диктування й озвучення окремо, локально або в хмарі.', 'Перетворюйте озвучені думки на текст у полі повідомлення.', 'Озвучення відповідей', 'Слухайте відповіді, продовжуючи працювати.', 'Налаштувати диктування', 'Налаштувати озвучення',
    'Більше плагінів OpenCode',
    'Привіт, ласкаво просимо до Yuri. Підготуйтеся за чотири кроки', 'Підключіть модель, додайте інструменти, імпортуйте історію та налаштуйте голос. Кожен крок можна відкласти.', 'Моделі', 'Інструменти', 'Голос',
    'Не вдалося завантажити інформацію про плагін. Спробуйте ще раз.', 'Налаштовано', 'Не вдалося зберегти: {names}. Успішні зміни збережено.',
    'Немає доступних моделей. Підключіть постачальника та спробуйте ще раз.', 'Операція не вдалася. Збережені зміни залишаються; спробуйте ще раз.',
    'Magpie — це плагін. Додайте його тут один раз; на кроці інструментів повторний вибір не потрібен.', 'Інший постачальник', 'Голос Doubao від Volcengine підтримує диктування та озвучення відповідей.', 'Безкоштовна квота дає змогу випробувати особисте використання. Ліміти, терміни дії та додаткові платежі вказано в консолі Volcengine.', 'Налаштувати голос Doubao', 'Налаштувати пізніше', 'Почати користування', 'Зберегти й продовжити', 'Відкрити посібник налаштування',
  ]),
};

const connectionMessages = (description: string, recommended: string, docs: string) => ({
  'tour.magpieDescription': description,
  'tour.recommended': recommended,
  'tour.docs': docs,
});

const tourMessagesBase = {
  en: { ...tourStepMessages.en, ...connectionMessages('Manage subscriptions, API keys and local models in Magpie, or connect a provider directly through OpenCode below.', 'Recommended', 'Setup guide') },
  'zh-CN': { ...tourStepMessages['zh-CN'], ...connectionMessages('用 Magpie 统一管理订阅、API Key 和本地模型，也可以通过下方的 OpenCode 接入方式直接连接提供商。', '推荐', '接入指南') },
  'zh-TW': { ...tourStepMessages['zh-TW'], ...connectionMessages('用 Magpie 統一管理訂閱、API Key 和本機模型，也可以透過下方的 OpenCode 接入方式直接連接供應商。', '推薦', '連接指南') },
  ja: { ...tourStepMessages.ja, ...connectionMessages('Magpie でサブスクリプション、API キー、ローカルモデルを一元管理できます。下の OpenCode の接続方法でプロバイダーに直接接続することもできます。', 'おすすめ', '接続ガイド') },
  ko: { ...tourStepMessages.ko, ...connectionMessages('Magpie에서 구독, API 키, 로컬 모델을 한곳에서 관리하거나 아래 OpenCode 연결 방식으로 공급자에 직접 연결하세요.', '추천', '연결 안내') },
  es: { ...tourStepMessages.es, ...connectionMessages('Gestiona suscripciones, claves API y modelos locales con Magpie, o conecta un proveedor directamente mediante OpenCode abajo.', 'Recomendado', 'Guía de conexión') },
  fr: { ...tourStepMessages.fr, ...connectionMessages('Gérez vos abonnements, clés API et modèles locaux dans Magpie, ou connectez directement un fournisseur via OpenCode ci-dessous.', 'Recommandé', 'Guide de connexion') },
  pl: { ...tourStepMessages.pl, ...connectionMessages('Zarządzaj subskrypcjami, kluczami API i modelami lokalnymi w Magpie lub połącz dostawcę bezpośrednio przez OpenCode poniżej.', 'Polecane', 'Instrukcja połączenia') },
  'pt-BR': { ...tourStepMessages['pt-BR'], ...connectionMessages('Gerencie assinaturas, chaves API e modelos locais no Magpie ou conecte um provedor diretamente pelo OpenCode abaixo.', 'Recomendado', 'Guia de conexão') },
  uk: { ...tourStepMessages.uk, ...connectionMessages('Керуйте підписками, ключами API та локальними моделями в Magpie або підключіть постачальника безпосередньо через OpenCode нижче.', 'Рекомендовано', 'Посібник із підключення') },
};

export const tourMessages = {
  en: { ...tourMessagesBase.en, ...historyImportMessages.en },
  'zh-CN': { ...tourMessagesBase['zh-CN'], ...historyImportMessages['zh-CN'] },
  'zh-TW': { ...tourMessagesBase['zh-TW'], ...historyImportMessages['zh-TW'] },
  ja: { ...tourMessagesBase.ja, ...historyImportMessages.ja },
  ko: { ...tourMessagesBase.ko, ...historyImportMessages.ko },
  es: { ...tourMessagesBase.es, ...historyImportMessages.es },
  fr: { ...tourMessagesBase.fr, ...historyImportMessages.fr },
  pl: { ...tourMessagesBase.pl, ...historyImportMessages.pl },
  'pt-BR': { ...tourMessagesBase['pt-BR'], ...historyImportMessages['pt-BR'] },
  uk: { ...tourMessagesBase.uk, ...historyImportMessages.uk },
};
