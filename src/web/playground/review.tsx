import { createRoot } from 'react-dom/client';
import { ReviewApp } from '../../../engine/src/web/review.tsx';
import { playgroundApi } from './api.ts';
import '../../../engine/src/web/style.css';

const params = new URLSearchParams(location.search);
const task = params.get('task') || 'example-clarity';
const transport = <T,>(route: string, body?: unknown) => playgroundApi<T>(`/playground-reviews/${task}${route}`, body);
createRoot(document.getElementById('root')!).render(<ReviewApp task={task} pinned={null} transport={transport}/>);
