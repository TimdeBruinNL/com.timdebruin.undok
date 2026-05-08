UNDOK — Homey App

Contrôlez votre radio internet UNDOK / Frontier Silicon directement depuis Homey.

Cette application n'est pas affiliée à Frontier Silicon Ltd. ou à la marque UNDOK, ni
approuvée par ceux-ci. UNDOK est une marque déposée de Frontier Silicon Ltd. Cette
application utilise le protocole FSAPI local pour communiquer directement avec les
appareils compatibles sur votre réseau local.


APPAREILS PRIS EN CHARGE

Toute radio internet basée sur la puce Frontier Silicon prenant en charge le protocole
FSAPI et compatible avec l'application UNDOK. Cela inclut des radios de marques telles
que Kenwood, Hama, Medion, Revo, Roberts, Ruark et bien d'autres.


FONCTIONNALITÉS

- Découverte automatique des radios sur votre réseau local via SSDP
- Contrôle de plusieurs radios indépendamment
- Allumer/éteindre
- Sélectionner la source (Radio Internet, DAB+, FM, CD, USB)
- Sélectionner un préréglage (station de radio internet)
- Contrôle du volume (régler, augmenter, diminuer, couper le son, rétablir le son)
- Contrôle de la lecture (lecture, pause, piste suivante, piste précédente)
- Informations sur la lecture en cours : source, nom de la station, chanson et artiste
- Intégration complète des Flows avec déclencheurs, conditions et actions


CARTES FLOW

Quand : Radio allumée · Radio éteinte · Volume modifié · Préréglage modifié
Et : Radio est allumée · Radio est éteinte · Radio est en mode silencieux · Préréglage actuel est égal à · Volume actuel est
Alors : Allumer · Éteindre · Sélectionner la source · Sélectionner le préréglage · Régler le volume · Augmenter le volume · Diminuer le volume · Couper le son · Rétablir le son · Lecture · Pause · Piste suivante · Piste précédente · Allumer avec source + préréglage + volume


INSTALLATION

1. Installez l'application
2. Allez dans Ajouter un appareil et sélectionnez UNDOK
3. Votre radio sera découverte automatiquement
4. Si votre radio utilise un code PIN non standard, modifiez-le dans les paramètres de
   l'appareil après l'association (code PIN par défaut : 1234)


REMARQUES

- La radio doit être sur le même réseau local que votre Homey
- Le contrôle de lecture (lecture, pause, suivant, précédent) ne fonctionne que lorsqu'une
  source appropriée est sélectionnée (CD ou USB)
- L'état de la radio est interrogé toutes les 5 secondes


ASSISTANCE

Pour toute question ou problème, veuillez visiter :
https://github.com/TimdeBruinNL/com.timdebruin.undok/issues
