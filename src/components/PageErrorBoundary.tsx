import {Component,type ReactNode} from 'react';
import {Button} from './ui';

/** Keep failed page imports recoverable without automatically discarding edits. */
export default class PageErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    if(this.state.failed)return <main className="empty" role="alert">
      <h1>This page couldn’t load.</h1>
      <p>Reload the page to try again. Reloading may discard unsaved changes.</p>
      <Button type="button" onClick={()=>window.location.reload()}>Reload page</Button>
    </main>;
    return this.props.children;
  }
}
