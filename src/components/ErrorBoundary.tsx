import * as React from 'react';
import { RefreshCcw, Home, AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught application error:", error, errorInfo);
  }

  public override componentDidMount() {
    window.addEventListener('error', this.handleGlobalError);
    window.addEventListener('unhandledrejection', this.handlePromiseRejection);
  }

  public override componentWillUnmount() {
    window.removeEventListener('error', this.handleGlobalError);
    window.removeEventListener('unhandledrejection', this.handlePromiseRejection);
  }

  private handleGlobalError = (event: ErrorEvent) => {
    this.setState({ hasError: true, error: event.error || new Error(event.message) });
  };

  private handlePromiseRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    this.setState({
      hasError: true,
      error: reason instanceof Error ? reason : new Error(String(reason))
    });
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#1a1c2c] text-slate-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900/80 backdrop-blur-md rounded-3xl p-8 shadow-2xl border border-red-500/30 text-center space-y-6">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto text-red-500 border border-red-500/20 shadow-lg shadow-red-550/5">
              <AlertTriangle size={32} />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-black text-white">던전 시공간 왜곡 감지</h2>
              <p className="text-slate-400 text-xs font-medium leading-relaxed">
                데이터베이스 조회 중 또는 네트워크 불안정으로 인해 오류가 감지되었습니다.
              </p>
            </div>
            <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 text-[10px] text-red-400 font-mono text-left max-h-36 overflow-auto whitespace-pre-wrap custom-scrollbar">
              {this.state.error?.message || '알 수 없는 시공간 왜곡 현상'}
            </pre>
            <div className="flex gap-2.5 pt-2">
              <button
                onClick={() => {
                  window.location.reload();
                }}
                className="flex-1 rounded-xl px-4 py-3 font-bold text-xs bg-brand text-white border-b-4 border-brand-hover hover:brightness-110 active:scale-95 transition-all shadow-lg flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RefreshCcw size={14} />
                다시 시도하기
              </button>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.hash = '';
                  window.location.reload();
                }}
                className="rounded-xl px-4 py-3 font-bold text-xs bg-slate-850 hover:bg-slate-800 text-slate-300 border border-slate-700 active:scale-95 transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Home size={14} />
                메인화면으로
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
