function GitHubMark(): JSX.Element {
  return (
    <svg
      className="gh-mark"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

function GearIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z" />
    </svg>
  );
}

interface Props {
  filePath: string | null;
  dirty: boolean;
  viewMode: 'split' | 'tabs';
  tocVisible: boolean;
  ghMode: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onToggleViewMode: () => void;
  onToggleToc: () => void;
  onToggleGh: () => void;
  onShowShortcuts: () => void;
  onShowSettings: () => void;
}

export default function Toolbar(props: Props): JSX.Element {
  const {
    filePath,
    dirty,
    viewMode,
    tocVisible,
    ghMode,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onToggleViewMode,
    onToggleToc,
    onToggleGh,
    onShowShortcuts,
    onShowSettings,
  } = props;

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled';

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button type="button" onClick={onNew}>New</button>
        <button type="button" onClick={onOpen}>Open</button>
        <button type="button" onClick={onSave}>Save</button>
        <button type="button" onClick={onSaveAs}>Save As</button>
      </div>
      <div className="toolbar-center">
        <span className="filename">
          {fileName}
          {dirty ? ' •' : ''}
        </span>
      </div>
      <div className="toolbar-right">
        <button
          type="button"
          className="icon-button"
          onClick={onShowShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onShowSettings}
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className={tocVisible ? 'active' : ''}
          onClick={onToggleToc}
          title="Toggle Table of Contents (TOC)"
        >
          TOC
        </button>
        <button
          type="button"
          className={ghMode ? 'active' : ''}
          onClick={onToggleGh}
          aria-label="Toggle GitHub extensions"
        >
          <GitHubMark />
          GH Ext
        </button>
        <div className="view-toggle">
          <button
            type="button"
            className={viewMode === 'split' ? 'active' : ''}
            onClick={() => viewMode === 'tabs' && onToggleViewMode()}
          >
            Split
          </button>
          <button
            type="button"
            className={viewMode === 'tabs' ? 'active' : ''}
            onClick={() => viewMode === 'split' && onToggleViewMode()}
          >
            Tabs
          </button>
        </div>
      </div>
    </header>
  );
}
