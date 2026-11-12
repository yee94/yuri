import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectRuntimeAPIs as useRuntimeAPIs } from '@/lib/api/useProjectRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { fileContentQueryKey, setFileContentSnapshot, useFileContentQuery } from '@/queries/fileQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { DiagramEditor, type DiagramEditorHandle } from '@/components/diagram';
import { Icon } from '@/components/icon/Icon';

export function DiagramView() {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const queryClient = useQueryClient();
  const effectiveDirectory = useEffectiveDirectory() ?? null;
  const transport = getRuntimeTransportIdentity();

  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [xml, setXml] = React.useState('');
  const editorRef = React.useRef<DiagramEditorHandle>(null);
  const mountedRef = React.useRef(false);
  const latestRequestRef = React.useRef<{
    path: string;
    generation: number;
    transport: string;
    scopeDirectory: string | null;
  } | null>(null);
  const requestGenerationRef = React.useRef(0);
  const saveQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  const pendingDiagramFile = useUIStore((state) => state.pendingDiagramFile);
  const fileQuery = useFileContentQuery(
    { scopeDirectory: effectiveDirectory, path: filePath },
    { enabled: Boolean(filePath) },
  );

  if (filePath && (
    latestRequestRef.current?.path !== filePath
    || latestRequestRef.current.transport !== transport
    || latestRequestRef.current.scopeDirectory !== effectiveDirectory
  )) {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    latestRequestRef.current = { path: filePath, generation, transport, scopeDirectory: effectiveDirectory };
  }

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  React.useEffect(() => {
    if (!pendingDiagramFile) {
      return;
    }
    const pending = useUIStore.getState().consumePendingDiagramFile();
    if (pending) {
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      latestRequestRef.current = {
        path: pending,
        generation,
        transport,
        scopeDirectory: effectiveDirectory,
      };
      setFilePath(pending);
    }
  }, [effectiveDirectory, pendingDiagramFile, transport]);

  React.useEffect(() => {
    const request = latestRequestRef.current;
    if (!request || request.path !== filePath || request.transport !== transport || request.scopeDirectory !== effectiveDirectory) {
      return;
    }
    if (fileQuery.data !== undefined) {
      setXml(fileQuery.data);
      return;
    }
    if (fileQuery.isError) {
      setXml('');
    }
  }, [effectiveDirectory, filePath, fileQuery.data, fileQuery.isError, transport]);

  const saveDiagram = React.useCallback(async () => {
    const newXml = editorRef.current?.getXml();
    const request = latestRequestRef.current;
    const writeFile = files?.writeFile;
    if (!filePath || !writeFile || !newXml || newXml === xml || request?.path !== filePath) return;

    const { path, generation, scopeDirectory, transport: requestTransport } = request;
    const save = saveQueueRef.current.then(async () => {
      try {
        const result = await writeFile(path, newXml);
        if (!result?.success) {
          throw new Error(t('filesView.toast.writeFileFailed'));
        }
        const fileInput = { scopeDirectory, path };
        await queryClient.cancelQueries({ queryKey: fileContentQueryKey(fileInput, requestTransport), exact: true });
        setFileContentSnapshot(queryClient, fileInput, requestTransport, newXml);
        const latestRequest = latestRequestRef.current;
        if (
          mountedRef.current
          && latestRequest?.path === path
          && latestRequest.generation === generation
          && latestRequest.transport === requestTransport
          && latestRequest.scopeDirectory === scopeDirectory
        ) {
          setXml(newXml);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      }
    });
    saveQueueRef.current = save.catch(() => undefined);
    await save;
  }, [filePath, files, queryClient, t, xml]);

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <div className="typography-ui text-muted-foreground">
          {t('filesView.editor.pickFileFromTree')}
        </div>
      </div>
    );
  }

  if (fileQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <Icon name="loader-4" className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <Icon name="file" className="size-4 shrink-0 text-muted-foreground" />
        <span className="typography-ui text-muted-foreground truncate flex-1">{fileName}</span>
        <button
          type="button"
          onClick={() => void saveDiagram()}
          className="size-6 flex items-center justify-center rounded-md text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={t('filesView.diagram.saveDiagram')}
        >
          <Icon name="save-3" className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveMainTab('chat')}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={t('filesView.diagram.closeDiagramView')}
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <DiagramEditor
          ref={editorRef}
          xml={xml}
          className="h-full"
        />
      </div>
    </div>
  );
}
