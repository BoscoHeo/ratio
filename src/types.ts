/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Question {
  q: string;
  o: string[];
  a: number;
  difficulty?: number;
}

export type GameMode = 'single' | 'group' | 'versus';
export type Screen = 'main' | 'setup' | 'game' | 'result' | 'ranking' | 'setup-vs' | 'teacher' | 'teacher-dashboard' | 'student-lobby';

export interface RPGStats {
  level: number;
  xp: number;
  title: string;
  power: number;
  wisdom: number;
}

export interface ScoreEntry {
  id?: string;
  name: string;
  score: number;
  level: number;
  mode: GameMode;
  roomCode?: string;
  timestamp: any; // Firestore Timestamp
}

export interface Room {
  code: string;
  teacher: string;
  createdAt: any;
}

