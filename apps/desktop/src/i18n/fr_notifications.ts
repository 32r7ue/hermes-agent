// Notification settings copy used when the desktop locale loads.
export const frNotifications = {
  title: 'Notifications',
  intro: "Notifications système (pas les toasts de l'application). Par appareil.",
  enableAll: 'Activer les notifications',
  enableAllDesc: 'Désactivé coupe toutes les notifications ci-dessous.',
  focusedHint: 'Les alertes de fin ne se déclenchent que quand Hermes est en arrière-plan.',
  kinds: {
    approval: {
      label: 'Approbation requise',
      description: "Une commande attend que vous l'approuviez ou la rejetiez."
    },
    input: {
      label: 'Saisie requise',
      description: "Hermes a posé une question ou a besoin d'un mot de passe ou d'un secret."
    },
    turnDone: {
      label: 'Réponse prête',
      description: "Un tour s'est terminé pendant que Hermes était en arrière-plan."
    },
    turnError: {
      label: 'Échec du tour',
      description: 'Erreurs de tour en arrière-plan.'
    },
    backgroundDone: {
      label: 'Tâche en arrière-plan terminée',
      description: "Une commande terminal en arrière-plan s'est terminée."
    },
    credits: {
      label: 'Alertes de crédits',
      description: "L'accès aux crédits est suspendu ou rétabli."
    },
    plugin: {
      label: 'Notifications des plugins',
      description: 'Un plugin desktop a envoyé une notification pendant que Hermes était en arrière-plan.'
    }
  },
  browserPermission: {
    title: 'Notifications du navigateur',
    allow: 'Autoriser',
    states: {
      default:
        "Affiche des alertes de ce navigateur quand l'onglet est en arrière-plan. Tant que vous ne l'autorisez pas, seul le titre de l'onglet clignote.",
      granted:
        "Autorisé. Les alertes s'affichent quand cet onglet est en arrière-plan ; le titre de l'onglet clignote aussi.",
      denied: "Bloqué dans les paramètres du site de ce navigateur. Le titre de l'onglet clignote quand même.",
      insecure: "Nécessite HTTPS, par exemple Tailscale serve. En HTTP simple, seul le titre de l'onglet clignote.",
      unsupported: "Ce navigateur ne peut pas afficher de notifications. Le titre de l'onglet clignote quand même."
    }
  },
  test: 'Envoyer une notification de test',
  testTitle: 'Hermes',
  testBody: 'Les notifications fonctionnent.',
  testSent:
    "Test envoyé. Si rien n'apparaît, vérifiez les autorisations de notification de votre système et le mode Ne pas déranger.",
  testUnsupported: 'Ce système ne prend pas en charge les notifications natives.',
  muteSoundsTitle: 'Couper les sons de l’interface',
  muteSoundsDesc:
    'Coupe les signaux automatiques de fin, d’activation et de réflexion, le retour haptique et les sons des notifications système. Les aperçus sonores et les réponses vocales restent audibles.',
  completionSoundTitle: 'Son de fin',
  completionSoundDesc: "Se joue à la fin d'un tour d'agent. Choisissez un préréglage et prévisualisez-le ici.",
  completionSoundPreview: 'Aperçu',
  chatCues: {
    sent: {
      label: 'Son d\'envoi',
      description: 'Le son de Cursor quand vous envoyez ou réorientez un message.'
    },
    thinking: {
      label: 'Son de réflexion',
      description: 'La pulsation douce de Cursor pendant que l\'agent travaille : après 4 secondes, puis toutes les ~6 secondes jusqu\'à la fin du tour ou s\'il a besoin de vous.'
    },
    fileEdited: {
      label: 'Son de fichier modifié',
      description: 'Le son de Cursor quand l\'agent termine de modifier un fichier.'
    },
    approval: {
      label: 'Son d\'approbation',
      description: 'Les sons de Cursor quand vous approuvez ou refusez une demande.'
    }
  }
}
